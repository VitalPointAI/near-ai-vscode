// The COP map component's interface contract and its offline rule (WP-COP; UX concept 12.3 and 12.4; research note 11, 4.4 and 6). The page script runs
// here on a small stand-in DOM: it mounts with the SVG renderer when WebGL is missing, with MapLibre when the library is there, and both answer the same
// interface. It makes no network request of its own, its MapLibre style names no tile, glyph or sprite source, and it filters by the shared clock with the
// same rule as the host's picture. The picture, the synthetic geography and the content security policy are checked beside it.
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildCopFeature, buildCopPicture, COP_TRACK_BUDGET, scenarioReference, SCENARIO_LAYER, syntheticGeography, visibleFeatures } from '../domain/staff/cop';
import type { CopPicture, PictureFeature } from '../domain/staff/cop';
import { gridToWgs84, insideFrame, wgs84ToGrid } from '../domain/staff/obs/frame';
import type { Observation } from '../domain/staff/obs/observation';
import { parseScenarioText } from '../domain/staff/scenario';
import { COP_MAP_FILES, copMapCsp, copMapResources } from '../staff/copMapWebview';
import { scenarioEnvironment } from '../staff/envPack';

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = readFileSync(path.join(REPO, 'media', 'staff', 'copMap.js'), 'utf8');
const DECLUTTER = readFileSync(path.join(REPO, 'media', 'staff', 'declutter.js'), 'utf8');
const DRAWER = readFileSync(path.join(REPO, 'media', 'staff', 'layerDrawer.js'), 'utf8');

function starter() {
  const parsed = parseScenarioText(readFileSync(path.join(REPO, 'resources', 'staff', 'scenarios', 'iron-lantern.json'), 'utf8'));
  assert.ok(parsed.ok);
  return parsed.value;
}

// ---- A stand-in DOM ---------------------------------------------------------------------------------------------------------------------------

class Node {
  /** A short form for failure messages: a fake node links to its document, parent and children, and printing that whole graph grew past 20 GB. */
  [inspect.custom](): string { return `<${this.tag}${(this as { id?: unknown }).id ? '#' + String((this as { id?: unknown }).id) : ''}${(this as { className?: unknown }).className ? '.' + String((this as { className?: unknown }).className).split(/\s+/).join('.') : ''}>`; }
  public children: Node[] = [];
  public parentNode: Node | undefined;
  public attributes = new Map<string, string>();
  public listeners = new Map<string, Array<(event: unknown) => void>>();
  public textContent = '';
  public hidden = false;
  [key: string]: unknown;
  public constructor(public readonly tag: string) {}
  public get firstChild(): Node | undefined { return this.children[0]; }
  public get lastChild(): Node | undefined { return this.children[this.children.length - 1]; }
  public get childNodes(): Node[] { return this.children; }
  public appendChild(child: Node): Node { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.push(child); if (this.tag === 'head' && child.tag === 'script') requests.push(String(child.src)); return child; }
  public removeChild(child: Node): Node { this.children = this.children.filter((item) => item !== child); child.parentNode = undefined; return child; }
  public setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  public getAttribute(key: string): string | undefined { return this.attributes.get(key); }
  public addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  public dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener({}); }
  public getContext(): null { return null; }
  public all(): Node[] { return [this, ...this.children.flatMap((child) => child.all())]; }
  // What the layer drawer (media/staff/layerDrawer.js) uses: classes, focus and the Web Animations API.
  public className = '';
  public get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (name: string) => list().includes(name),
      add: (name: string) => { if (!list().includes(name)) this.className = [...list(), name].join(' '); },
      remove: (name: string) => { this.className = list().filter((item) => item !== name).join(' '); },
      toggle: (name: string, force?: boolean) => { const on = force ?? !list().includes(name); this.className = on ? [...new Set([...list(), name])].join(' ') : list().filter((item) => item !== name).join(' '); return on; }
    };
  }
  public focus(): void { focused = this; }
  public get tagName(): string { return this.tag.toUpperCase(); }
  public animations: Array<{ frames: Array<Record<string, unknown>>; onfinish?: () => void; finish(): void; cancel(): void }> = [];
  public animate(frames: Array<Record<string, unknown>>): { frames: Array<Record<string, unknown>>; onfinish?: () => void; finish(): void; cancel(): void } {
    const animation = { frames, onfinish: undefined as undefined | (() => void), finish() { this.onfinish?.(); }, cancel() {} };
    this.animations.push(animation);
    return animation;
  }
  public key(key: string, shiftKey = false): boolean {
    let prevented = false;
    for (const listener of this.listeners.get('keydown') ?? []) listener({ key, shiftKey, preventDefault: () => { prevented = true; }, stopPropagation() {} });
    return prevented;
  }
  public click(): void { for (const listener of this.listeners.get('click') ?? []) listener({}); }
}

let requests: string[] = [];
let focused: Node | undefined;
let documentListeners = new Map<string, Array<(event: unknown) => void>>();

class FakeMap {
  public static last: FakeMap | undefined;
  public projections: unknown[] = [];
  public data = new Map<string, unknown>();
  private handlers = new Map<string, Array<(event?: unknown) => void>>();
  public constructor(public readonly options: { style: unknown }) { FakeMap.last = this; setTimeout(() => this.fire('load'), 0); }
  public addControl(): void {}
  public on(type: string, handler: (event?: unknown) => void): void { this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]); }
  public once(type: string, handler: (event?: unknown) => void): void { this.on(type, handler); }
  public fire(type: string, event?: unknown): void { for (const handler of this.handlers.get(type) ?? []) handler(event); }
  public getSource(id: string) { return { setData: (data: unknown) => { this.data.set(id, data); } }; }
  public setProjection(projection: unknown): void { this.projections.push(projection); }
  public camera: Array<[string, Record<string, unknown>]> = [];
  public fitBounds(bounds: unknown, options: Record<string, unknown>): void { this.camera.push(['fitBounds', { bounds, ...options }]); }
  public flyTo(options: Record<string, unknown>): void { this.camera.push(['flyTo', options]); }
  public jumpTo(options: Record<string, unknown>): void { this.camera.push(['jumpTo', options]); }
  public getContainer() { return { clientWidth: 800, clientHeight: 600 }; }
  public hasImage(): boolean { return false; }
  public addImage(): void {}
  public queryRenderedFeatures(): unknown[] { return []; }
  public filters = new Map<string, unknown>();
  public paints: Array<[string, string, unknown]> = [];
  public setFilter(layer: string, filter: unknown): void { this.filters.set(layer, filter); }
  public setPaintProperty(layer: string, name: string, value: unknown): void { this.paints.push([layer, name, value]); }
  public focused = 0;
  public getCanvas() { return { focus: () => { this.focused += 1; } }; }
  public remove(): void {}
}

interface Page { window: Record<string, unknown>; container: Node }

/** The page's timers that have neither fired nor been cleared, with their delay: a timer the page forgets shows up here. */
const liveTimers = new Map<ReturnType<typeof setTimeout>, number>();
function pageSetTimeout(fn: () => void, ms?: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(() => { liveTimers.delete(handle); fn(); }, ms);
  liveTimers.set(handle, ms ?? 0);
  return handle;
}
function pageClearTimeout(handle: ReturnType<typeof setTimeout> | undefined): void {
  if (handle !== undefined) liveTimers.delete(handle);
  clearTimeout(handle);
}

function page(options: { reduced?: boolean } = {}): Page {
  requests = [];
  liveTimers.clear();
  focused = undefined;
  documentListeners = new Map();
  const head = new Node('head');
  const document = {
    head,
    createElement: (tag: string) => new Node(tag),
    createElementNS: (_ns: string, tag: string) => new Node(tag),
    get activeElement() { return focused; },
    addEventListener: (type: string, listener: (event: unknown) => void) => { documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]); },
    removeEventListener: (type: string, listener: (event: unknown) => void) => { documentListeners.set(type, (documentListeners.get(type) ?? []).filter((item) => item !== listener)); }
  };
  const record = (kind: string) => (url: unknown) => { requests.push(`${kind} ${String(url)}`); return Promise.reject(new Error('offline')); };
  const window: Record<string, unknown> = {};
  const context: Record<string, unknown> = {
    window, document, console, setTimeout: pageSetTimeout, clearTimeout: pageClearTimeout, Date, Math, JSON, Promise, Map, Object, Array, Number, String, Boolean, Error, isFinite,
    matchMedia: (query: string) => ({ matches: Boolean(options.reduced) && /reduce/.test(query) }),
    fetch: record('fetch'),
    XMLHttpRequest: class { public open(_method: string, url: string) { requests.push(`xhr ${url}`); } public send() {} },
    WebSocket: class { public constructor(url: string) { requests.push(`websocket ${url}`); } },
    EventSource: class { public constructor(url: string) { requests.push(`eventsource ${url}`); } },
    Image: class { public set src(url: string) { requests.push(`image ${url}`); } }
  };
  vm.createContext(context);
  // The page loads the shared label placement first (staffRoomPanel.ts), then the map.
  new vm.Script(DECLUTTER, { filename: 'declutter.js' }).runInContext(context);
  new vm.Script(DRAWER, { filename: 'layerDrawer.js' }).runInContext(context);
  new vm.Script(SCRIPT, { filename: 'copMap.js' }).runInContext(context);
  return { window, container: new Node('div') };
}

const wait = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

/** A picture with timed features: a threat-layer symbol valid from 12:00 to 14:00, recorded at 12:30, and a two-point feed track. */
function timedPicture(): CopPicture {
  const scenario = starter();
  const frame = scenario.region.frame!;
  const built = buildCopFeature('cop-threat-layer', { id: 'e-1-41', kind: 'symbol', name: '1-41 MECH', sidc: '10061000161211020000', at: 'KQ 4532', validFrom: '2026-11-18T12:00:00.000Z', validTo: '2026-11-18T14:00:00.000Z' }, frame, 'threat-analyst', '2026-11-18T12:30:00.000Z');
  assert.ok(built.ok);
  const ecoa = buildCopFeature('cop-threat-layer', { id: 'ecoa-2', kind: 'axis-adversary', name: 'ECOA 2', path: ['KQ 4835', 'KQ 4529'], ecoa: 'ECOA-2', ecoaRole: 'MDCOA' }, frame, 'threat-analyst', '2026-11-18T12:00:00.000Z');
  assert.ok(ecoa.ok);
  const row = (n: number, minute: string): Observation => ({
    obsId: `obs-${String(n).repeat(64)}`.slice(0, 68), trackId: 'mmsi:111', label: 'org/Internal', validAt: `2026-11-18T12:${minute}:00.000Z`, knownAt: `2026-11-18T12:${minute}:30.000Z`,
    geometry: { type: 'Point', coordinates: [frame.origin.longitude + 0.5, frame.origin.latitude + 0.3 + n * 0.01] }, simulated: true, source: 'AIS sim', origin: 'AIS sim',
    reliability: 'B', credibility: 2, feed: 'ais', channel: 'sim'
  } as unknown as Observation);
  return buildCopPicture({
    marking: scenario.marking, frame, geography: syntheticGeography(scenario), scenario,
    layers: [{ layer: 'cop-threat-layer', features: [built.value, ecoa.value], writer: { section: 'j2', member: 'threat-analyst' } }],
    feeds: { rows: [row(1, '10'), row(2, '40')], visible: () => true, now: Date.parse('2026-11-18T13:00:00.000Z'), decay: () => null, layersOf: () => ['cop-feed-maritime'] }
  });
}

// ---- The interface ----------------------------------------------------------------------------------------------------------------------------

test('without WebGL the component mounts the SVG map behind the same interface, says why, and refuses the globe', async () => {
  const { window, container } = page();
  const api = window.nearCopMap as { version: number; mount: (container: Node, options: unknown) => Promise<Record<string, any>> };
  assert.equal(api.version, 1);
  const selected: unknown[] = [];
  const view = await api.mount(container, { renderer: 'auto', onSelect: (feature: unknown) => selected.push(feature) });
  for (const method of ['setPicture', 'setTime', 'setMode', 'setProjection', 'setLayerVisible', 'setEcoa', 'select', 'destroy']) assert.equal(typeof view[method], 'function', method);
  assert.equal(view.renderer, 'svg');
  assert.match(view.reason, /WebGL is not available/);
  assert.ok(container.all().some((node) => node.textContent.startsWith('Showing the 2D SVG map')), 'the page says it fell back');
  const picture = timedPicture();
  view.setPicture(picture);
  assert.equal(view.setProjection('globe'), false, 'the SVG map is 2D only');
  view.setTime(Date.parse('2026-11-18T13:00:00.000Z'));
  await wait();
  const svgRoot = container.all().find((node) => node.tag === 'svg')!;
  assert.ok(svgRoot.all().some((node) => node.getAttribute('data-id') === 'cop-threat-layer/e-1-41'), 'the symbol is drawn');
  assert.ok(!svgRoot.all().some((node) => node.getAttribute('data-id') === 'cop-threat-layer/ecoa-2'), 'an ECOA overlay is off until chosen');
  view.setEcoa('ECOA-2');
  await wait();
  assert.ok(container.all().some((node) => node.getAttribute('data-id') === 'cop-threat-layer/ecoa-2'));
  view.select('cop-threat-layer/e-1-41');
  assert.equal((selected[0] as PictureFeature).properties.name, '1-41 MECH');
  assert.ok(container.all().some((node) => node.textContent === 'Hostile land unit, infantry, armoured or mechanized, battalion'), 'the card says the affiliation in words');
  view.destroy();
  assert.equal(container.children.length, 0);
  assert.deepEqual(requests, [], 'the SVG map makes no request at all');
});

test('the page filters by the shared clock with the host\'s rule, as happened and as known, and draws a track at its latest position only', async () => {
  const { window, container } = page();
  const picture = timedPicture();
  const subscribers: Array<(t: number) => void> = [];
  let set: number | undefined;
  const clock = { now: () => Date.parse('2026-11-18T11:00:00.000Z'), subscribe: (fn: (t: number) => void) => { subscribers.push(fn); return () => undefined; }, set: (t: number) => { set = t; } };
  const view = await (window.nearCopMap as { mount: (c: Node, o: unknown) => Promise<Record<string, any>> }).mount(container, { renderer: 'svg', clock });
  view.setPicture(picture);
  view.setLayerVisible('cop-feed-maritime', true);
  const pageVisible = window.nearCopMap as { visibleFeatures: (f: unknown, t: number, m: string) => PictureFeature[] };
  for (const minute of ['11:00', '12:15', '12:35', '12:45', '13:30', '14:30']) {
    for (const mode of ['valid', 'known'] as const) {
      const t = Date.parse(`2026-11-18T${minute}:00.000Z`);
      assert.deepEqual(JSON.parse(JSON.stringify(pageVisible.visibleFeatures(picture.features, t, mode).map((f) => f.id))), visibleFeatures(picture.features, t, mode).map((f) => f.id), `${minute} ${mode}`);
    }
  }
  const at = (minute: string, mode: 'valid' | 'known') => visibleFeatures(picture.features, Date.parse(`2026-11-18T${minute}:00.000Z`), mode).map((f) => f.id);
  assert.ok(!at('11:00', 'valid').includes('cop-threat-layer/e-1-41') && at('12:15', 'valid').includes('cop-threat-layer/e-1-41'));
  assert.ok(!at('12:15', 'known').includes('cop-threat-layer/e-1-41') && at('12:35', 'known').includes('cop-threat-layer/e-1-41'), 'as known: it was recorded at 12:30');
  assert.ok(!at('14:30', 'valid').includes('cop-threat-layer/e-1-41'), 'no longer valid after 14:00');
  assert.equal(at('12:45', 'valid').filter((id) => id.startsWith('cop-feed-maritime/')).length, 1, 'one position per track');
  subscribers[0](Date.parse('2026-11-18T12:45:00.000Z'));
  await wait();
  assert.deepEqual(JSON.parse(JSON.stringify(view.state().drawn)).sort(), at('12:45', 'valid').filter((id: string) => !id.startsWith(`${SCENARIO_LAYER}/`) && id !== 'cop-threat-layer/ecoa-2').sort(), 'the clock moved the map (the reference layer hides once a layer is written, and no ECOA overlay is chosen)');
  const range = container.all().find((node) => node.tag === 'input' && node.type === 'range')!;
  range.value = '0';
  range.dispatch('input');
  assert.equal(set, picture.time!.min, 'moving the slider sets the shared clock');
  view.setMode('known');
  await wait();
  assert.equal(view.state().mode, 'known');
});

test('with MapLibre the component uses a style with no remote source, switches to the globe, and asks for nothing', async () => {
  const { window, container } = page();
  const view = await (window.nearCopMap as { mount: (c: Node, o: unknown) => Promise<Record<string, any>> }).mount(container, { renderer: 'auto', projection: 'map', libraries: { maplibregl: { Map: FakeMap, NavigationControl: class {} } } });
  assert.equal(view.renderer, 'maplibre');
  const map = FakeMap.last!;
  const style = JSON.stringify(map.options.style);
  assert.doesNotMatch(style, /https?:|glyphs|sprite|tiles|"url"|pmtiles/i, 'no tile, glyph or sprite source');
  assert.match(style, /"type":"geojson"/);
  view.setPicture(timedPicture());
  await wait();
  assert.ok((map.data.get('ground') as { features: unknown[] }).features.length > 0, 'the synthetic geography is the ground');
  assert.equal(view.setProjection('globe'), true);
  await wait(10);
  assert.deepEqual(JSON.parse(JSON.stringify(map.projections)), [{ type: 'globe' }]);
  view.setProjection('map');
  await wait(10);
  assert.deepEqual(JSON.parse(JSON.stringify(map.projections[1])), { type: 'mercator' });
  assert.deepEqual(requests, [], 'no request beyond the libraries the host gave');
});

test('when MapLibre is ready first, the 15-second "never wait forever" timer is cleared, not left pending behind the view', async () => {
  const { window, container } = page();
  const view = await (window.nearCopMap as { mount: (c: Node, o: unknown) => Promise<Record<string, any>> }).mount(container, { renderer: 'auto', libraries: { maplibregl: { Map: FakeMap, NavigationControl: class {} } } });
  assert.equal(view.renderer, 'maplibre');
  assert.deepEqual([...liveTimers.values()].filter((ms) => ms === 15000), [], 'no 15-second timer is left once the map is ready');
  view.destroy();
});

test('MapLibre places names with its collision index: symbols always stay, a name that does not fit is dropped, and symbol images carry no text', async () => {
  const { window, container } = page();
  const view = await (window.nearCopMap as { mount: (c: Node, o: unknown) => Promise<Record<string, any>> }).mount(container, { renderer: 'auto', still: true, libraries: { maplibregl: { Map: FakeMap, NavigationControl: class {} } } });
  const map = FakeMap.last!;
  const options = map.options as { style: { layers: Array<{ id: string; type: string; layout?: Record<string, unknown> }>; glyphs?: unknown }; fadeDuration?: number };
  assert.equal(options.fadeDuration, 0, 'still: no label fades (Calm and reduced motion)');
  assert.equal(options.style.glyphs, undefined, 'no glyph server: MapLibre draws the letters locally');
  const layers = options.style.layers;
  const points = layers.find((layer) => layer.id === 'points')!;
  assert.equal(points.layout!['icon-allow-overlap'], true, 'a symbol is never dropped');
  assert.equal(points.layout!['icon-ignore-placement'], false, 'a symbol claims its room, so no name covers it');
  assert.equal(layers.at(-1)!.id, 'points', 'the symbols are the top layer, so MapLibre places them first');
  const names = layers.find((layer) => layer.id === 'point-labels')!;
  assert.equal(names.layout!['text-allow-overlap'], false);
  assert.equal(names.layout!['text-optional'], true);
  assert.ok((names.layout!['text-variable-anchor'] as string[]).length >= 4, 'a name tries several places around its symbol');
  assert.ok(Number(names.layout!['text-padding']) >= 2);
  assert.ok(Number(names.layout!['text-radial-offset']) >= 1.5, 'clear of its own symbol');
  const textLayers = layers.filter((layer) => layer.type === 'symbol' && layer.layout && 'text-field' in layer.layout);
  // The ground's own labels (index contour heights, grid numbers) are the lowest: any picture name wins a crowded spot over them.
  assert.deepEqual(JSON.parse(JSON.stringify(textLayers.map((layer) => layer.id))), ['contour-labels', 'grid-labels-10', 'grid-labels-1', 'area-labels', 'line-labels', 'place-labels', 'point-labels'], 'then names of symbols, then places, then control measures, then the ground');
  for (const layer of textLayers) assert.equal(layer.layout!['text-allow-overlap'], false, `${layer.id} never covers another label`);
  view.setPicture(timedPicture());
  view.setTime(Date.parse('2026-11-18T13:00:00.000Z'));
  view.setEcoa('ECOA-2');
  await wait();
  // Point symbols are on their own clustered source (units); lines and areas stay on the cop source.
  const units = map.data.get('units') as { features: Array<{ geometry: { type: string }; properties: Record<string, unknown> }> };
  const cop = map.data.get('cop') as { features: Array<{ geometry: { type: string }; properties: Record<string, unknown> }> };
  assert.ok(units.features.every((feature) => feature.geometry.type === 'Point') && cop.features.every((feature) => feature.geometry.type !== 'Point'));
  const mech = units.features.find((feature) => feature.properties.fid === 'cop-threat-layer/e-1-41')!;
  assert.equal(mech.properties.aff, 'H', 'the affiliation a stacked symbol counts');
  assert.equal(mech.properties.icon, 'sym|10061000161211020000|live', 'the symbol image is keyed without its name');
  assert.equal(mech.properties.text, '1-41 MECH', 'the name is a label of its own');
  view.highlight(['mdcoa']);
  await wait(10);
  assert.match(JSON.stringify(map.filters.get('hilite-lines')), /cop-threat-layer\/ecoa-2/, 'an adversary COA is highlighted by its role');
  view.highlight([]);
  await wait(10);
  assert.doesNotMatch(JSON.stringify(map.filters.get('hilite-lines')), /ecoa-2/);
  view.setColours({ ocean: '#123456', land: 'url(https://example.invalid/x.png)', label: 'rgba(1, 2, 3, .5)' });
  await wait(10);
  assert.ok(map.paints.some(([layer, name, value]) => layer === 'ocean' && name === 'background-color' && value === '#123456'));
  assert.ok(map.paints.some(([layer, name, value]) => layer === 'point-labels' && name === 'text-color' && value === 'rgba(1, 2, 3, .5)'));
  assert.ok(!JSON.stringify(map.paints).includes('url('), 'only colours reach the style');
  view.focus();
  assert.equal(map.focused, 1, 'focus goes to the map canvas, which MapLibre drives from the keyboard');
  assert.deepEqual(requests, []);
});

test('the SVG map places every name so no two labels overlap near Port Calder, keeping every symbol', async () => {
  const { window, container } = page();
  const scenario = starter();
  const picture = buildCopPicture({ marking: scenario.marking, frame: scenario.region.frame, geography: syntheticGeography(scenario), scenario, layers: [] });
  const view = await (window.nearCopMap as { mount: (c: Node, o: unknown) => Promise<Record<string, any>> }).mount(container, { renderer: 'svg' });
  view.setPicture(picture);
  await wait();
  const labels = JSON.parse(JSON.stringify(view.state().labels)) as Record<string, { hidden: boolean; box?: { x: number; y: number; w: number; h: number }; text?: string }>;
  const placed = Object.entries(labels).filter(([, label]) => !label.hidden);
  assert.ok(placed.length >= 10, `${placed.length} labels placed`);
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i][1].box!; const b = placed[j][1].box!;
      assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${placed[i][0]} and ${placed[j][0]} overlap`);
    }
  }
  const svgRoot = container.all().find((node) => node.tag === 'svg')!;
  const symbols = picture.features.filter((feature) => feature.properties.kind === 'symbol').map((feature) => feature.id);
  for (const id of symbols) assert.ok(svgRoot.all().some((node) => node.getAttribute('data-id') === id), `${id} keeps its symbol`);
  assert.ok(svgRoot.all().some((node) => node.getAttribute('data-for')?.startsWith('~place/') && node.textContent === 'Port Calder'), 'Port Calder is named');
});

test('the COP map and the Staff Room\'s SVG map share one label placement, media/staff/declutter.js, and neither keeps a copy', () => {
  const room = readFileSync(path.join(REPO, 'media', 'staffRoom', 'staffMap.js'), 'utf8');
  for (const [name, source] of [['copMap.js', SCRIPT], ['staffMap.js', room]] as const) {
    assert.doesNotMatch(source, /function declutter\(|const LABEL_OFFSETS|function shortName\(/, `${name} keeps no copy of the label placement`);
    assert.match(source, /window\.nearDeclutter && window\.nearDeclutter\.declutter/, `${name} reads the shared routine`);
  }
  assert.match(DECLUTTER, /function declutter\(labels, obstacles\)/);
  const { window } = page();
  assert.equal(window.nearCopMap && (window.nearCopMap as { declutter: unknown }).declutter, (window.nearDeclutter as { declutter: unknown }).declutter, 'the map exports the shared routine itself');
  const declutter = (window.nearCopMap as { declutter: (labels: unknown[], obstacles: unknown[]) => Record<string, { hidden: boolean; text?: string }> }).declutter;
  const crowd = Array.from({ length: 12 }, (_, n) => ({ id: `l${String(n).padStart(2, '0')}`, x: 100 + (n % 3) * 4, y: 100 + Math.floor(n / 3) * 3, w: 60, h: 12, gap: 8, prio: n % 2, text: `Label number ${n}`, size: 10 }));
  const out = JSON.parse(JSON.stringify(declutter(crowd, [{ x: 95, y: 95, w: 10, h: 10, owner: 'l00' }])));
  const shown = Object.values(out).filter((entry) => !(entry as { hidden: boolean }).hidden);
  assert.ok(shown.length >= 4 && shown.length < crowd.length, 'some names fit, the rest are hidden');
  // A name too long for the only free band is shortened before it is dropped.
  const band = declutter([{ id: 'b', x: 100, y: 100, w: 300, h: 10, gap: 25, prio: 1, text: 'Alpha Bravo', size: 10 }], [{ x: 130, y: 0, w: 1000, h: 300, owner: 'x' }, { x: -1000, y: 0, w: 1070, h: 300, owner: 'x' }]);
  assert.equal(band.b.text, 'Alpha\u2026');
  assert.equal(declutter([{ id: 'c', x: 100, y: 100, w: 300, h: 10, gap: 25, prio: 1, text: 'Alpha', size: 10 }], [{ x: -1000, y: -1000, w: 3000, h: 3000, owner: 'x' }]).c.hidden, true, 'a name with no room at all is hidden');
  assert.deepEqual(JSON.parse(JSON.stringify(declutter(crowd, []))), JSON.parse(JSON.stringify(declutter(crowd.slice().reverse(), []))), 'the same input in any order places the same way');
});

// ---- The layer drawer and the map's room (owner direction, D-48 of 0.4.34) -----------------------------------------------------------------

type Drawer = { button: Node; panel: Node; setGroups(groups: unknown[]): void; open(): void; close(returnFocus?: boolean): void; isOpen(): boolean; destroy(): void };
const drawerApi = (window: Record<string, unknown>) => window.nearLayerDrawer as { create: (host: Node, options: unknown) => Drawer; grouped: (items: unknown[]) => unknown[] };
const switches = (root: Node) => root.all().filter((node) => node.getAttribute('role') === 'switch');
const sampleGroups = (on: Record<string, boolean>) => [
  { id: 'picture', title: 'Picture', items: [{ id: 'ops', title: 'Operations', count: 4, on: on.ops ?? true, sim: false, owner: 'j3 current-ops' }, { id: 'plans', title: 'Plans (COA sketches)', count: 0, on: on.plans ?? false, sim: false, separate: true }] },
  { id: 'environment', title: 'Environment', items: [{ id: 'hill', title: 'Hillshade', count: 166, on: on.hill ?? true, sim: true }] },
  { id: 'reference', title: 'Reference', items: [] }
];

test('the layer drawer: a compact Layers button with how many are on, groups with counts and SIM, a switch per layer, and Escape back to the button', () => {
  const { window } = page();
  const host = new Node('div');
  const toggled: Array<[string, boolean]> = [];
  const drawer = drawerApi(window).create(host, { onToggle: (id: string, on: boolean) => toggled.push([id, on]) });
  host.appendChild(drawer.button);
  drawer.setGroups(sampleGroups({}));
  assert.equal(drawer.button.all().find((node) => node.className === 'ld-count')!.textContent, '2');
  assert.equal(drawer.button.getAttribute('aria-label'), 'Layers, 2 of 3 on');
  assert.equal(drawer.button.getAttribute('aria-expanded'), 'false');
  assert.equal(drawer.panel.hidden, true, 'closed until asked');
  assert.equal(drawer.panel.getAttribute('role'), 'dialog');
  const titles = drawer.panel.all().filter((node) => node.className === 'ld-group-title').map((node) => node.textContent);
  assert.deepEqual(titles, ['Picture', 'Environment'], 'an empty group is left out');
  assert.deepEqual(drawer.panel.all().filter((node) => node.className === 'ld-tally').map((node) => node.textContent), ['1 of 2 on', '1 of 1 on']);
  assert.ok(drawer.panel.all().some((node) => node.className === 'ld-sim'), 'the SIM badge where a layer is simulated');
  assert.match(switches(drawer.panel).find((node) => node.getAttribute('data-layer') === 'hill')!.getAttribute('aria-label')!, /^Hillshade, 166, simulated$/);
  assert.match(switches(drawer.panel)[0].getAttribute('aria-label')!, /written by j3 current-ops/);

  drawer.button.click();
  assert.equal(drawer.isOpen(), true);
  assert.equal(drawer.panel.hidden, false);
  assert.equal(drawer.button.getAttribute('aria-expanded'), 'true');
  assert.equal(focused, switches(drawer.panel)[0], 'focus moves to the first switch');
  switches(drawer.panel)[1].click();
  assert.deepEqual(toggled, [['plans', true]], 'a switch asks for the opposite of its state');
  assert.equal(drawer.panel.key('Escape'), true);
  assert.equal(drawer.isOpen(), false);
  assert.equal(drawer.panel.hidden, true, 'still: hidden at once');
  assert.equal(focused, drawer.button, 'focus returns to the Layers button');
  assert.equal(drawer.panel.animations.length, 0, 'nothing moves when motion is off');
});

test('the layer drawer keeps Tab inside while open, closes on a click outside without taking focus, and keeps focus on a switch when it redraws', () => {
  const { window } = page();
  const host = new Node('div');
  let groups = sampleGroups({});
  const drawer = drawerApi(window).create(host, { onToggle: (id: string, on: boolean) => { groups = sampleGroups({ [id]: on }); drawer.setGroups(groups); } });
  host.appendChild(drawer.button);
  drawer.setGroups(groups);
  drawer.open();
  const inside = (window.nearLayerDrawer as { focusables: (root: Node) => Node[] }).focusables(drawer.panel);
  const close = inside[0];
  assert.equal(close.className, 'ld-close');
  const last = inside[inside.length - 1];
  last.focus();
  assert.equal(drawer.panel.key('Tab'), true, 'Tab on the last control wraps');
  assert.equal(focused, inside[0]);
  assert.equal(drawer.panel.key('Tab', true), true, 'Shift+Tab on the first control wraps back');
  assert.equal(focused, last);
  // A redraw (the person turned a layer on) keeps focus on the same layer's switch.
  const plans = switches(drawer.panel).find((node) => node.getAttribute('data-layer') === 'plans')!;
  plans.focus();
  plans.click();
  const again = switches(drawer.panel).find((node) => node.getAttribute('data-layer') === 'plans')!;
  assert.notEqual(again, plans);
  assert.equal(again.getAttribute('aria-checked'), 'true');
  assert.equal(focused, again);
  assert.equal(drawer.button.getAttribute('aria-label'), 'Layers, 3 of 3 on');
  // A click outside closes it; focus stays where the person clicked.
  const elsewhere = new Node('div');
  elsewhere.focus();
  for (const listener of documentListeners.get('pointerdown') ?? []) listener({ target: drawer.panel.children[1] });
  assert.equal(drawer.isOpen(), true, 'a click inside keeps it open');
  for (const listener of documentListeners.get('pointerdown') ?? []) listener({ target: elsewhere });
  assert.equal(drawer.isOpen(), false);
  assert.equal(focused, elsewhere);
  drawer.destroy();
  assert.equal((documentListeners.get('pointerdown') ?? []).length, 0, 'the outside-click listener is let go');
});

test('the layer drawer slides with transform and opacity only when motion is allowed, and hides after its exit animation', () => {
  const { window } = page();
  const host = new Node('div');
  let moving = true;
  const drawer = drawerApi(window).create(host, { motion: () => moving });
  drawer.setGroups(sampleGroups({}));
  drawer.open();
  drawer.close(true);
  assert.equal(drawer.panel.animations.length, 2);
  for (const animation of drawer.panel.animations) for (const frame of animation.frames) assert.deepEqual(Object.keys(frame).sort(), ['opacity', 'transform']);
  assert.equal(drawer.panel.hidden, false, 'shown until the exit animation ends');
  drawer.panel.animations[1].finish();
  assert.equal(drawer.panel.hidden, true);
  moving = false;
  drawer.open();
  drawer.close();
  assert.equal(drawer.panel.animations.length, 2, 'reduced motion or Calm: no new animation');
  assert.equal(drawer.panel.hidden, true);
});

test('the COP map floats its controls over the map, groups its layers in the drawer, fits the land, places and units and flies to the globe and back', async () => {
  const { window, container } = page();
  const layerCalls: Array<[string, boolean]> = [];
  let motion = true;
  const view = await (window.nearCopMap as { mount: (c: Node, o: unknown) => Promise<Record<string, any>> }).mount(container, {
    renderer: 'auto', still: true, motion: () => motion, onLayer: (id: string, on: boolean) => layerCalls.push([id, on]),
    libraries: { maplibregl: { Map: FakeMap, NavigationControl: class {} }}
  });
  const map = FakeMap.last!;
  const scenario = starter();
  const read = await scenarioEnvironment(scenario);
  const picture = buildCopPicture({ marking: scenario.marking, frame: scenario.region.frame, geography: syntheticGeography(scenario), scenario, layers: [], environment: read!.environment });
  view.setPicture(picture);
  await wait();
  // Layout: the canvas has the box; a strip, the tools and the time float over it; no list of checkboxes sits above the map any more.
  const root = container.children[0];
  assert.deepEqual(root.children.map((node) => node.className).slice(0, 3), ['cop-map-canvas', 'cop-map-top', 'cop-map-foot']);
  assert.ok(!container.all().some((node) => node.tag === 'input' && node.type === 'checkbox'), 'no checkbox block');
  const strip = container.all().find((node) => node.className === 'cop-map-strip')!;
  assert.equal(strip.children[0].textContent, picture.marking, 'the classification line on the map');
  // The drawer: the base map (Topographic and Plain here: no tiles were given), then three groups, environment with hillshade and contours, the
  // scenario for reference.
  const titles = container.all().filter((node) => node.className === 'ld-group-title').map((node) => node.textContent);
  assert.deepEqual(titles, ['Base map', 'Picture', 'Environment', 'Reference']);
  const ids = switches(root).map((node) => node.getAttribute('data-layer'));
  assert.ok(['env-hillshade', 'env-contours', 'env-weather', 'cop-terrain-layer'].every((id) => ids.includes(id)));
  const hill = switches(root).find((node) => node.getAttribute('data-layer') === 'env-hillshade')!;
  hill.click();
  await wait();
  assert.deepEqual(layerCalls, [['env-hillshade', false]], 'the host hears of the change');
  assert.equal(view.state().visible['env-hillshade'], false);
  assert.equal(switches(root).find((node) => node.getAttribute('data-layer') === 'env-hillshade')!.getAttribute('aria-checked'), 'false');
  // The first view fits the land, the places and the units with a margin, inside the frame (owner direction, 0.4.35), with room for the floating chrome;
  // the frame's dashed line is still drawn.
  const fit = map.camera.find(([kind]) => kind === 'fitBounds')!;
  const b = picture.frame!.bounds;
  const [[w, s], [e, n]] = JSON.parse(JSON.stringify(fit[1].bounds)) as [[number, number], [number, number]];
  assert.deepEqual([w, s, e, n], JSON.parse(JSON.stringify((window.nearCopMap as { contentBounds: (p: unknown) => number[] }).contentBounds(picture))));
  assert.ok(w >= b[0] && s >= b[1] && e <= b[2] && n <= b[3], 'inside the frame');
  assert.ok((e - w) * (n - s) < 0.7 * (b[2] - b[0]) * (b[3] - b[1]), `closer than the whole frame (${JSON.stringify([w, s, e, n])} in ${JSON.stringify(b)})`);
  const inside = (c: number[]) => c[0] >= w && c[0] <= e && c[1] >= s && c[1] <= n;
  const coast = picture.environment!.contours.features.filter((feature) => feature.properties.kind === 'coastline');
  assert.ok(coast.length > 0, 'the pack has a coastline');
  for (const feature of coast) for (const c of (feature.geometry as unknown as { coordinates: number[][] }).coordinates) assert.ok(inside(c), `the coastline is in view: ${JSON.stringify(c)}`);
  const inFrame = (c: number[]) => c[0] >= b[0] && c[0] <= b[2] && c[1] >= b[1] && c[1] <= b[3];
  for (const feature of picture.features) if (feature.geometry.type === 'Point' && inFrame(feature.geometry.coordinates as unknown as number[])) assert.ok(inside(feature.geometry.coordinates as unknown as number[]), `${feature.id} is in view`);
  assert.equal(fit[1].animate, false);
  // Hillshade drawn stronger than the pack's own tones, in the theme's colours; units clustered on their own source.
  const style = map.options.style as { sources: Record<string, Record<string, unknown>>; layers: Array<{ id: string; paint?: Record<string, unknown>; minzoom?: number }> };
  assert.match(JSON.stringify(style.layers.find((layer) => layer.id === 'env-hillshade')!.paint!['fill-opacity']), /1\.8/);
  assert.equal(style.sources.units.cluster, true);
  assert.ok(style.layers.some((layer) => layer.id === 'clusters'));
  assert.equal(style.layers.find((layer) => layer.id === 'points')!.minzoom, 5, 'the globe shows the frame ring, not the units');
  assert.ok((map.data.get('frame') as { features: unknown[] }).features.length === 2, 'the frame and its centre');
  // Globe flies out to a zoom where the curve is plain; Map flies back to the same first view.
  view.setProjection('globe');
  await wait(10);
  const out = map.camera.at(-1)!;
  assert.equal(out[0], 'flyTo');
  assert.ok(Number(out[1].zoom) < 3, `zoomed out to ${String(out[1].zoom)}`);
  assert.deepEqual(JSON.parse(JSON.stringify(out[1].center)), JSON.parse(JSON.stringify(picture.frame!.centre)));
  view.setProjection('map');
  await wait(10);
  assert.equal(map.camera.at(-1)![0], 'fitBounds');
  assert.equal(map.camera.at(-1)![1].animate, true);
  assert.deepEqual(JSON.parse(JSON.stringify(map.camera.at(-1)![1].bounds)), [[w, s], [e, n]], 'back to the same first view');
  // Under reduced motion or Calm the same moves are instant.
  motion = false;
  view.setProjection('globe');
  await wait(10);
  assert.equal(map.camera.at(-1)![0], 'jumpTo');
  view.setProjection('map');
  await wait(10);
  assert.equal(map.camera.at(-1)![1].animate, false);
  // A host's tool joins the map's own controls; the drawer opens and closes through the view.
  const extra = new Node('button');
  view.addTool(extra);
  assert.ok(container.all().find((node) => node.className === 'cop-map-tools')!.children.includes(extra));
  assert.equal(view.layers(true), true);
  assert.equal(view.layers(false), false);
  view.destroy();
  assert.equal((documentListeners.get('pointerdown') ?? []).length, 0);
  assert.deepEqual(requests, []);
});

test('the COP map is still under the system\'s reduced-motion setting when the host gives no rule of its own', async () => {
  const { window, container } = page({ reduced: true });
  const view = await (window.nearCopMap as { mount: (c: Node, o: unknown) => Promise<Record<string, any>> }).mount(container, { renderer: 'auto', libraries: { maplibregl: { Map: FakeMap, NavigationControl: class {} } } });
  const map = FakeMap.last!;
  view.setPicture(timedPicture());
  await wait();
  view.setProjection('globe');
  await wait(10);
  assert.equal(map.camera.at(-1)![0], 'jumpTo');
  view.layers(true);
  view.layers(false);
  const panel = container.all().find((node) => node.className.startsWith('ld-panel'))!;
  assert.equal(panel.animations.length, 0);
});

test('the page script names no remote address and the CSP allows no eval, no inline script and no remote source', () => {
  const urls = SCRIPT.match(/https?:\/\/[^\s'")]+/g) ?? [];
  assert.deepEqual(urls, ['http://www.w3.org/2000/svg'], 'only the SVG namespace, which is never fetched');
  assert.doesNotMatch(SCRIPT, /\beval\(|new Function\(|innerHTML|insertAdjacentHTML|document\.write/);
  const csp = copMapCsp('https://file+.vscode-resource.vscode-cdn.net', 'bm9uY2UxMjM0NTY3OA==');
  assert.match(csp, /script-src 'nonce-bm9uY2UxMjM0NTY3OA=='(;|$)/);
  assert.match(csp, /worker-src blob:/);
  assert.match(csp, /connect-src https:\/\/file\+\.vscode-resource\.vscode-cdn\.net(;|$)/);
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|\*|http:/);
  assert.throws(() => copMapCsp('x', "a' 'unsafe-eval"));
  const resources = copMapResources((file) => `RES/${file}`);
  assert.deepEqual(Object.keys(resources).sort(), Object.keys(COP_MAP_FILES).sort());
  for (const file of Object.values(COP_MAP_FILES)) assert.ok(readFileSync(path.join(REPO, 'media', file)).length > 0, file);
});

test('the first view: land, places and units with a margin inside the frame; the frame when nothing is placed; nothing outside the frame widens it', () => {
  const { window } = page();
  const contentBounds = (window.nearCopMap as { contentBounds: (p: unknown) => number[] }).contentBounds;
  const frame = { grid: 'KQ', bounds: [0, 0, 1, 1] as const, centre: [0.5, 0.5] as const };
  const base = { frame, features: [] as unknown[], geography: { type: 'FeatureCollection', features: [] as unknown[] } };
  assert.deepEqual(JSON.parse(JSON.stringify(contentBounds({ ...base }))), [0, 0, 1, 1], 'nothing placed: the frame');
  const land = { type: 'Feature', properties: { kind: 'land' }, geometry: { type: 'Polygon', coordinates: [[[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.4]]] } };
  const unit = { id: 'u', type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0.6, 0.7] } };
  const away = { id: 'x', type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [5, 5] } };
  const road = { type: 'Feature', properties: { kind: 'road' }, geometry: { type: 'LineString', coordinates: [[0.05, 0.05], [0.95, 0.95]] } };
  const got = contentBounds({ ...base, geography: { type: 'FeatureCollection', features: [land, road] }, features: [unit, away] });
  // The box 0.4..0.6 by 0.4..0.7, a margin of a tenth of the larger side (0.03): a road or a point outside the frame does not widen it.
  assert.deepEqual([...got].map((x) => Number(x.toFixed(6))), [0.37, 0.37, 0.63, 0.73]);
  // The terrain pack's coastline counts as land; the margin never leaves the frame.
  const coast = { type: 'Feature', properties: { kind: 'coastline' }, geometry: { type: 'LineString', coordinates: [[0.01, 0.2], [0.3, 0.99]] } };
  const wide = contentBounds({ ...base, environment: { contours: { type: 'FeatureCollection', features: [coast] } }, features: [unit] });
  assert.deepEqual([...wide].map((x) => Number(x.toFixed(6))), [0, 0.121, 0.679, 1]);
});

// ---- The picture ------------------------------------------------------------------------------------------------------------------------------

test('the picture keeps the plans layer apart, shows the scenario for reference until layers are written, and cuts feed tracks to the budget with a note', () => {
  const scenario = starter();
  const empty = buildCopPicture({ marking: scenario.marking, frame: scenario.region.frame, scenario, layers: [] });
  assert.equal(empty.budget.limit, COP_TRACK_BUDGET);
  assert.equal(COP_TRACK_BUDGET, 2000);
  const plans = empty.layers.find((layer) => layer.id === 'cop-plans-layer')!;
  assert.equal(plans.separate, true);
  assert.equal(plans.visible, false, 'the plans layer never merges into the current picture');
  assert.equal(empty.layers.find((layer) => layer.id === SCENARIO_LAYER)!.visible, true);
  assert.equal(scenarioReference(scenario).filter((feature) => feature.properties.kind === 'symbol').length, scenario.forces.filter((force) => /KQ \d{4}/.test(force.location)).length, 'every force with a grid reference is on the reference layer');
  assert.ok(empty.layers.filter((layer) => layer.kind === 'feed').every((layer) => layer.note?.includes('No observation store')));

  const frame = scenario.region.frame!;
  const rows = Array.from({ length: 5 }, (_, n) => ({
    obsId: `obs-${n}`, trackId: `mmsi:${n}`, label: 'org/Internal', validAt: `2026-11-18T12:0${n}:00.000Z`, knownAt: `2026-11-18T12:0${n}:00.000Z`,
    geometry: { type: 'Point', coordinates: [frame.origin.longitude + 0.4, frame.origin.latitude + 0.4] }, simulated: true, source: 's', origin: 'o', reliability: 'B', credibility: 2, feed: 'ais', channel: 'sim'
  })) as unknown as Observation[];
  const cut = buildCopPicture({ marking: 'M', frame, layers: [], budget: 3, feeds: { rows, visible: (label) => label === 'org/Internal', now: Date.parse('2026-11-18T13:00:00.000Z'), decay: () => null, layersOf: () => ['cop-feed-maritime'] } });
  assert.deepEqual(cut.budget, { limit: 3, tracks: 5, shown: 3, note: 'Showing the 3 most recently updated of 5 tracks (budget 3).' });
  assert.deepEqual(cut.features.map((feature) => feature.properties.track).sort(), ['mmsi:2', 'mmsi:3', 'mmsi:4']);
  const maritime = cut.layers.find((layer) => layer.id === 'cop-feed-maritime')!;
  assert.equal(maritime.simulated, true, 'the SIM badge');
  const hidden = buildCopPicture({ marking: 'M', frame, layers: [], feeds: { rows, visible: () => false, now: 0, decay: () => null, layersOf: () => ['cop-feed-maritime'] } });
  assert.equal(hidden.features.length, 0, 'rows the reader may not see are never in the picture');
});

test('the synthetic geography lies inside the frame, with the towns on land and the ships at sea', () => {
  const scenario = starter();
  const frame = scenario.region.frame!;
  const geography = syntheticGeography(scenario)!;
  const points = geography.features.flatMap((feature) => (feature.geometry.type === 'Point' ? [feature.geometry.coordinates] : feature.geometry.type === 'LineString' ? feature.geometry.coordinates : feature.geometry.coordinates[0]));
  for (const [longitude, latitude] of points) assert.ok(insideFrame(frame, wgs84ToGrid(frame, { latitude, longitude })), `${longitude}, ${latitude}`);
  const land = geography.features.filter((feature) => feature.properties.kind === 'land').map((feature) => (feature.geometry as unknown as { coordinates: [number, number][][] }).coordinates[0]);
  const onLand = (eastKm: number, northKm: number) => {
    const point = gridToWgs84(frame, { eastingMetres: eastKm * 1000, northingMetres: northKm * 1000 });
    return land.some((ring) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
        if ((yi > point.latitude) !== (yj > point.latitude) && point.longitude < ((xj - xi) * (point.latitude - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    });
  };
  for (const [name, e, n] of [['Saltmere', 43.5, 15.5], ['Port Calder', 46.5, 36.5], ['Kell', 49.5, 33.5], ['Ashby Ford', 45.5, 28.5], ['AA OAK', 43.5, 18.5], ['Gull Island', 41.1, 42.1]] as const) assert.ok(onLand(e, n), `${name} is on land`);
  for (const [name, e, n] of [['the command ship off Saltmere', 40.5, 14.5], ['MV ORLA in the Aurel Sea', 49.5, 43.5], ['the Varn Strait', 44, 41]] as const) assert.ok(!onLand(e, n), `${name} is at sea`);
  assert.match(geography.note, /Nothing on this map is a real place/);
});

// Last in the file on purpose: node:test runs each file in its own process, so this reads the peak resident memory of every test above.
test('the page tests stay within a 1 GB memory budget (a failure that printed the fake DOM once grew past 20 GB)', () => {
  const peakBytes = process.resourceUsage().maxRSS * 1024;
  assert.ok(peakBytes < 1024 * 1024 * 1024, `peak resident memory ${(peakBytes / 1048576).toFixed(0)} MB is over the 1 GB budget`);
});
