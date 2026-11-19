// The COP map component's interface contract and its offline rule (WP-COP; UX concept 12.3 and 12.4; research note 11, 4.4 and 6). The page script runs
// here on a small stand-in DOM: it mounts with the SVG renderer when WebGL is missing, with MapLibre when the library is there, and both answer the same
// interface. It makes no network request of its own, its MapLibre style names no tile, glyph or sprite source, and it filters by the shared clock with the
// same rule as the host's picture. The picture, the synthetic geography and the content security policy are checked beside it.
import assert from 'node:assert/strict';
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

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = readFileSync(path.join(REPO, 'media', 'staff', 'copMap.js'), 'utf8');
const DECLUTTER = readFileSync(path.join(REPO, 'media', 'staff', 'declutter.js'), 'utf8');

function starter() {
  const parsed = parseScenarioText(readFileSync(path.join(REPO, 'resources', 'staff', 'scenarios', 'iron-lantern.json'), 'utf8'));
  assert.ok(parsed.ok);
  return parsed.value;
}

// ---- A stand-in DOM ---------------------------------------------------------------------------------------------------------------------------

class Node {
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
  public appendChild(child: Node): Node { child.parentNode = this; this.children.push(child); if (this.tag === 'head' && child.tag === 'script') requests.push(String(child.src)); return child; }
  public removeChild(child: Node): Node { this.children = this.children.filter((item) => item !== child); child.parentNode = undefined; return child; }
  public setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  public getAttribute(key: string): string | undefined { return this.attributes.get(key); }
  public addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  public dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener({}); }
  public getContext(): null { return null; }
  public all(): Node[] { return [this, ...this.children.flatMap((child) => child.all())]; }
}

let requests: string[] = [];

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
  public fitBounds(): void {}
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

function page(): Page {
  requests = [];
  liveTimers.clear();
  const head = new Node('head');
  const document = {
    head,
    createElement: (tag: string) => new Node(tag),
    createElementNS: (_ns: string, tag: string) => new Node(tag)
  };
  const record = (kind: string) => (url: unknown) => { requests.push(`${kind} ${String(url)}`); return Promise.reject(new Error('offline')); };
  const window: Record<string, unknown> = {};
  const context: Record<string, unknown> = {
    window, document, console, setTimeout: pageSetTimeout, clearTimeout: pageClearTimeout, Date, Math, JSON, Promise, Map, Object, Array, Number, String, Boolean, Error, isFinite,
    fetch: record('fetch'),
    XMLHttpRequest: class { public open(_method: string, url: string) { requests.push(`xhr ${url}`); } public send() {} },
    WebSocket: class { public constructor(url: string) { requests.push(`websocket ${url}`); } },
    EventSource: class { public constructor(url: string) { requests.push(`eventsource ${url}`); } },
    Image: class { public set src(url: string) { requests.push(`image ${url}`); } }
  };
  vm.createContext(context);
  // The page loads the shared label placement first (staffRoomPanel.ts), then the map.
  new vm.Script(DECLUTTER, { filename: 'declutter.js' }).runInContext(context);
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
  assert.deepEqual(JSON.parse(JSON.stringify(textLayers.map((layer) => layer.id))), ['area-labels', 'line-labels', 'place-labels', 'point-labels'], 'then names of symbols, then places, then control measures');
  for (const layer of textLayers) assert.equal(layer.layout!['text-allow-overlap'], false, `${layer.id} never covers another label`);
  view.setPicture(timedPicture());
  view.setTime(Date.parse('2026-11-18T13:00:00.000Z'));
  view.setEcoa('ECOA-2');
  await wait();
  const cop = map.data.get('cop') as { features: Array<{ properties: Record<string, unknown> }> };
  const mech = cop.features.find((feature) => feature.properties.fid === 'cop-threat-layer/e-1-41')!;
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
