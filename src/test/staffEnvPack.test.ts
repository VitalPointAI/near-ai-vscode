// Environment packs (WP-ENV; research note 11, 6.4 and 9.2 item 4): the pack format and its JSON Schema, validation on load (hashes, frame, attribution),
// the synthetic IRON LANTERN pack made again from its seed, contours and hillshade from a DEM, the weather frame the time slider picks, the layers on the
// COP map with no request made, and the pack builder's refusals.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import Ajv from 'ajv';
import { buildCopPicture, ENV_LAYERS, pictureEnvironment, syntheticGeography } from '../domain/staff/cop';
import type { CopPicture } from '../domain/staff/cop';
import {
  checkManifest, contourLevel, demContours, demFromAsciiGrid, douglasSeaState, ENV_MANIFEST, gribTime, hillshade, IRON_LANTERN_SEED, packCoordinates,
  parseAsciiGrid, readEnvPack, syntheticEnvPack, weatherFrameAt, weatherFromBands, weatherLayer, writeEnvPack
} from '../domain/staff/env';
import type { Dem, EnvPack, PackFiles, WeatherGrid } from '../domain/staff/env';
import { insideFrame, wgs84ToGrid } from '../domain/staff/obs/frame';
import { parseScenarioText, SCENARIO_DIR } from '../domain/staff/scenario';
import { parseInjectScript } from '../domain/staff/sim/script';
import { loadCopPicture } from '../staff/copMapWebview';
import { BUNDLED_ENV_DIR, readEnvPackDir, scenarioEnvironment } from '../staff/envPack';

const REPO = path.resolve(__dirname, '..', '..');
const PACK_DIR = path.join(REPO, 'resources', 'staff', 'env', 'iron-lantern');
const SCHEMA = JSON.parse(readFileSync(path.join(REPO, 'resources', 'staff', 'env', 'env-pack.schema.json'), 'utf8'));
const NAMES = ['manifest.json', 'dem.json', 'coastline.geojson', 'weather.json', 'landcover.geojson'];
/** The four files of a version 1 pack (the size check below has always covered these). */
const V1_NAMES = ['manifest.json', 'dem.json', 'coastline.geojson', 'weather.json'];

function starter() {
  const parsed = parseScenarioText(readFileSync(path.join(REPO, 'resources', 'staff', 'scenarios', 'iron-lantern.json'), 'utf8'));
  assert.ok(parsed.ok);
  return parsed.value;
}

function committed(): Record<string, Buffer> {
  return Object.fromEntries(NAMES.map((name) => [name, readFileSync(path.join(PACK_DIR, name))]));
}

function bytes(files: Record<string, string>): PackFiles {
  return Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text, 'utf8')]));
}

function schemaCheck(definition?: string) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema(SCHEMA, 'pack');
  const validate = ajv.getSchema(definition ? `pack#/definitions/${definition}` : 'pack');
  assert.ok(validate);
  return (value: unknown) => validate(value) as boolean;
}

/** A small real-data pack: a 4 x 3 DEM somewhere real, built as the pack builder builds one. */
function realPack(overrides: { attribution?: string[]; sources?: Array<{ name: string; licence: string; url?: string }> } = {}): Record<string, string> {
  const dem: Dem = { format: 'near-env-dem', version: 1, bounds: [10, 50, 10.03, 50.02], width: 4, height: 3, units: 'm', noData: -32768, heights: [0, 10, 20, 30, 0, 15, 40, 60, 0, 5, 10, 20] };
  return writeEnvPack({
    id: 'training-area', title: 'Training area fixture', data: 'real', bounds: [10, 50, 10.03, 50.02],
    attribution: overrides.attribution ?? ['Elevation: Example Survey, licensed under CC BY 4.0'], licence: 'CC BY 4.0',
    sources: overrides.sources ?? [{ name: 'Example Survey elevation model', licence: 'CC BY 4.0', url: 'https://example.invalid/dem' }],
    dem, coastline: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[10, 50.02], [10, 50]] }, properties: { kind: 'coastline' } }] }
  });
}

// ---- The format and validation on load --------------------------------------------------------------------------------------------------------

test('the bundled IRON LANTERN pack validates against its frame and against the JSON Schema, and stays well under 1 MB', async () => {
  const scenario = starter();
  const read = await readEnvPackDir(PACK_DIR, { frame: scenario.region.frame, scenario: scenario.id });
  assert.ok(read?.ok, read && !read.ok ? read.problems.join('\n') : 'no pack');
  const files = committed();
  const total = V1_NAMES.reduce((sum, name) => sum + files[name].length, 0);
  assert.ok(total < 200 * 1024, `${total} bytes`);
  assert.ok(files['landcover.geojson'].length < 300 * 1024, `land cover ${files['landcover.geojson'].length} bytes`);
  const json = (name: string) => JSON.parse(files[name].toString('utf8'));
  assert.ok(schemaCheck()(json('manifest.json')), 'manifest');
  assert.ok(schemaCheck('dem')(json('dem.json')), 'dem');
  assert.ok(schemaCheck('weather')(json('weather.json')), 'weather');
  assert.ok(schemaCheck('coastline')(json('coastline.geojson')), 'coastline');
  assert.ok(schemaCheck('landcover')(json('landcover.geojson')), 'landcover');
  const manifest = json('manifest.json');
  assert.equal(manifest.data, 'synthetic');
  assert.equal(manifest.version, 2, 'a version 2 pack: land cover and tiles');
  assert.deepEqual(manifest.generator, { script: 'scripts/generate-env-pack.mjs', seed: IRON_LANTERN_SEED, version: 2 });
  assert.deepEqual(Object.keys(manifest.tiles), ['path', 'sha256', 'bytes']);
  assert.equal(manifest.tiles.path, 'tiles/index.json');
  assert.match(manifest.attribution[0], /Nothing in this pack is a real place or a real forecast/);
  assert.equal(path.join(BUNDLED_ENV_DIR, 'iron-lantern'), path.join(REPO, 'resources', 'staff', 'env', 'iron-lantern'), 'the extension reads the committed pack');
});

test('the synthetic pack is made again byte for byte from its seed, and another seed makes another pack', () => {
  const scenario = starter();
  // The manifest records the committed tile index's size and hash (the script makes the tiles; tiles are checked in staffMapTiles.test.ts).
  const index = readFileSync(path.join(PACK_DIR, 'tiles', 'index.json'));
  const again = syntheticEnvPack(scenario, { seed: IRON_LANTERN_SEED, tiles: { path: 'tiles/index.json', sha256: createHash('sha256').update(index).digest('hex'), bytes: index.length } })!;
  for (const name of NAMES) assert.equal(again[name], committed()[name].toString('utf8'), `${name} matches the generator (run node scripts/generate-env-pack.mjs)`);
  const other = syntheticEnvPack(scenario, { seed: 7 })!;
  assert.notEqual(other['dem.json'], again['dem.json']);
  assert.ok(readEnvPack(bytes(other), { frame: scenario.region.frame, scenario: scenario.id }).ok, 'any seed makes a valid pack');
});

test('a file changed after the pack was made is refused by its hash, and so is a manifest whose hash was edited', () => {
  const files = committed();
  const dem = Buffer.from(files['dem.json']);
  const at = dem.indexOf(Buffer.from('"heights":[\n')) + 12;
  dem[at] = dem[at] === 0x31 ? 0x32 : 0x31; // one digit of the first height
  const tampered = readEnvPack({ ...files, 'dem.json': dem });
  assert.equal(tampered.ok, false);
  assert.ok(!tampered.ok && tampered.problems.some((problem) => /dem\.json: its SHA-256 does not match/.test(problem)));
  const manifest = JSON.parse(files['manifest.json'].toString('utf8'));
  manifest.files.weather.sha256 = '0'.repeat(64);
  const edited = readEnvPack({ ...files, 'manifest.json': Buffer.from(JSON.stringify(manifest)) });
  assert.ok(!edited.ok && edited.problems.some((problem) => /weather\.json: its SHA-256/.test(problem)));
  const shorter = readEnvPack({ ...files, 'coastline.geojson': files['coastline.geojson'].subarray(1) });
  assert.ok(!shorter.ok && shorter.problems.some((problem) => /bytes, but the manifest records/.test(problem)));
  const missing = readEnvPack({ 'manifest.json': files['manifest.json'], 'dem.json': files['dem.json'] });
  assert.ok(!missing.ok && missing.problems.some((problem) => /coastline\.geojson is missing/.test(problem)));
});

test('no coordinate of the bundled pack lies outside the frame, and a pack that strays outside the frame is refused', () => {
  const scenario = starter();
  const frame = scenario.region.frame!;
  const read = readEnvPack(committed(), { frame, scenario: scenario.id });
  assert.ok(read.ok);
  const points = packCoordinates(read.value);
  assert.ok(points.length > 50);
  for (const [longitude, latitude] of points) assert.ok(insideFrame(frame, wgs84ToGrid(frame, { latitude, longitude })), `${longitude}, ${latitude}`);
  // The same pack with one coastline point 2 km south of the frame, hashes recomputed so only the frame check can catch it.
  const pack = read.value;
  const stray = pack.coastline.features.map((feature, index) => index === 0 && feature.geometry.type === 'Polygon'
    ? { ...feature, geometry: { type: 'Polygon' as const, coordinates: [[[feature.geometry.coordinates[0][0][0], frame.origin.latitude - 0.02] as const, ...feature.geometry.coordinates[0].slice(1)]] } }
    : feature);
  const rebuilt = (bounds = pack.manifest.bounds) => writeEnvPack({ ...pack.manifest, bounds, dem: pack.dem, coastline: { type: 'FeatureCollection', features: stray }, ...(pack.weather ? { weather: pack.weather } : {}) });
  const wider: [number, number, number, number] = [pack.manifest.bounds[0], pack.manifest.bounds[1] - 0.05, pack.manifest.bounds[2], pack.manifest.bounds[3]];
  const outside = readEnvPack(bytes(rebuilt(wider)), { frame, scenario: scenario.id });
  assert.ok(!outside.ok && outside.problems.some((problem) => /outside the exercise frame/.test(problem)), 'outside the frame');
  const offBox = readEnvPack(bytes(rebuilt()));
  assert.ok(!offBox.ok && offBox.problems.some((problem) => /outside the manifest's bounding box/.test(problem)), 'outside its own bounding box, even with no frame');
  const otherScenario = readEnvPack(committed(), { frame, scenario: 'another-scenario' });
  assert.ok(!otherScenario.ok && otherScenario.problems.some((problem) => /made for another scenario/.test(problem)));
});

test('a real-data pack carries its attribution and every source\'s licence; without them it is refused by the loader and the schema alike', () => {
  const good = realPack();
  const read = readEnvPack(bytes(good));
  assert.ok(read.ok, !read.ok ? read.problems.join('\n') : '');
  assert.deepEqual(read.value.manifest.attribution, ['Elevation: Example Survey, licensed under CC BY 4.0']);
  assert.equal(read.value.manifest.sources![0].licence, 'CC BY 4.0');
  assert.ok(schemaCheck()(JSON.parse(good[ENV_MANIFEST])));
  const environment = pictureEnvironment(read.value);
  assert.deepEqual(environment.pack.attribution, ['Elevation: Example Survey, licensed under CC BY 4.0'], 'the attribution reaches the map');
  const picture = buildCopPicture({ marking: 'M', layers: [], environment });
  assert.ok(picture.layers.filter((layer) => layer.kind === 'environment').every((layer) => layer.note?.includes('Example Survey')), 'every terrain layer says where it came from');
  assert.ok(picture.layers.filter((layer) => layer.kind === 'environment').every((layer) => !layer.simulated), 'real data has no SIM badge');

  for (const [why, files] of [['no attribution', realPack({ attribution: [] })], ['no sources', realPack({ sources: [] })]] as const) {
    const refused = readEnvPack(bytes(files));
    assert.equal(refused.ok, false, why);
    assert.equal(schemaCheck()(JSON.parse(files[ENV_MANIFEST])), false, `the schema refuses ${why} too`);
  }
  const noLicence = JSON.parse(good[ENV_MANIFEST]);
  noLicence.sources[0].licence = '';
  assert.equal(checkManifest(noLicence).ok, false);
  assert.equal(schemaCheck()(noLicence), false);
  const generated = { ...JSON.parse(good[ENV_MANIFEST]), generator: { script: 'x', seed: 1, version: 1 } };
  assert.equal(checkManifest(generated).ok, false, 'real data is never generated');
  assert.equal(schemaCheck()(generated), false);
  const unknown = { ...JSON.parse(good[ENV_MANIFEST]), tiles: 'https://example.invalid/{z}/{x}/{y}.png' };
  assert.equal(checkManifest(unknown).ok, false, 'a manifest cannot add a tile source');
  assert.equal(schemaCheck()(unknown), false);
  const escape = JSON.parse(good[ENV_MANIFEST]);
  escape.files.dem.path = '../../secrets.json';
  assert.equal(checkManifest(escape).ok, false, 'a manifest names only the format\'s own files');
  assert.equal(schemaCheck()(escape), false);
});

// ---- Contours and hillshade --------------------------------------------------------------------------------------------------------------------

test('contours: a single peak gives one closed diamond through the edge midpoints, a ramp gives one straight line, and a saddle is split the same way every time', () => {
  const grid = (width: number, values: number[]) => ({ width, height: values.length / width, at: (x: number, y: number) => values[y * width + x] });
  const peak = contourLevel(grid(3, [0, 0, 0, 0, 10, 0, 0, 0, 0]), 5);
  assert.equal(peak.length, 1);
  assert.equal(peak[0].closed, true);
  const ring = peak[0].points.slice(0, -1).map(([x, y]) => `${x},${y}`).sort();
  assert.deepEqual(ring, ['0.5,1', '1,0.5', '1,1.5', '1.5,1']);
  assert.deepEqual(peak[0].points[0], peak[0].points[peak[0].points.length - 1], 'a closed ring ends where it starts');

  const ramp = contourLevel(grid(4, [0, 10, 20, 30, 0, 10, 20, 30, 0, 10, 20, 30]), 15);
  assert.equal(ramp.length, 1);
  assert.equal(ramp[0].closed, false);
  assert.deepEqual(ramp[0].points.map(([x]) => x), [1.5, 1.5, 1.5], 'halfway between 10 and 20, on every row');
  assert.deepEqual(ramp[0].points.map(([, y]) => y).sort(), [0, 1, 2]);

  const saddle = contourLevel(grid(2, [10, 0, 0, 10]), 5);
  assert.equal(saddle.length, 2, 'two separate pieces');
  assert.deepEqual(JSON.parse(JSON.stringify(contourLevel(grid(2, [10, 0, 0, 10]), 5))), JSON.parse(JSON.stringify(saddle)));
  assert.equal(contourLevel(grid(2, [0, 0, 0, 0]), 5).length, 0, 'nothing above the level, no line');

  const dem: Dem = { format: 'near-env-dem', version: 1, bounds: [0, 0, 0.02, 0.02], width: 3, height: 3, units: 'm', noData: -32768, heights: [0, 0, 0, 0, 120, 0, 0, 0, 0] };
  const features = demContours(dem, 50);
  assert.deepEqual(features.map((feature) => feature.properties.height), [50, 100]);
  for (const feature of features) for (const [lon, lat] of feature.geometry.coordinates) assert.ok(lon > 0 && lon < 0.02 && lat > 0 && lat < 0.02, 'in degrees inside the bounds');
});

test('hillshade lights a slope that faces the north-west and shades one that faces the south-east, and leaves the sea unshaded', () => {
  // Row by row from the north: a ridge from the south-west corner to the north-east corner, falling to the north-west on one side and the south-east on the other.
  const width = 5, height = 5;
  const heights: number[] = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) heights.push(y === 0 && x === 0 ? 0 : 50 + 40 * (4 - Math.abs(x + y - 4)));
  const dem: Dem = { format: 'near-env-dem', version: 1, bounds: [0, 0, 0.004, 0.004], width, height, units: 'm', noData: -32768, heights };
  const shade = hillshade(dem);
  const flat = Math.cos(Math.PI / 4);
  assert.equal(shade[0], 0, 'sea is not shaded');
  assert.ok(shade[1 * width + 1] > flat, `a north-west-facing slope is lit (${shade[1 * width + 1]})`);
  assert.ok(shade[3 * width + 3] < flat, `a south-east-facing slope is in shadow (${shade[3 * width + 3]})`);
});

test('the IRON LANTERN terrain puts Harrow Ridge about 300 m above the valley and the marshes low and flat', () => {
  const scenario = starter();
  const read = readEnvPack(committed(), { frame: scenario.region.frame, scenario: scenario.id });
  assert.ok(read.ok);
  const dem = read.value.dem;
  const at = (eastKm: number, northKm: number) => dem.heights[Math.round((58 - northKm) / 0.5) * dem.width + Math.round((eastKm - 20) / 0.5)];
  let ridge = -Infinity;
  for (let e = 47; e <= 50; e += 0.5) for (let n = 26; n <= 33; n += 0.5) ridge = Math.max(ridge, at(e, n));
  assert.ok(ridge >= 280 && ridge <= 380, `Harrow Ridge (KQ 4726 to KQ 4932) tops out at ${ridge} m`);
  assert.ok(at(45.5, 28.5) < 60, `Ashby Ford in the valley ${at(45.5, 28.5)} m`);
  assert.equal(at(43, 26), 2, 'Brenn marshes');
  assert.ok(at(40, 14.5) < 0, 'the command ship off Saltmere is at sea');
  assert.ok(at(46.5, 36.5) > 0, 'Port Calder is on land');
  const environment = pictureEnvironment(read.value);
  assert.ok(environment.contours.features.some((feature) => feature.properties.kind === 'contour' && feature.properties.height === 300), 'a 300 m contour on the ridge');
  assert.ok(environment.hillshade.features.length > 20);
});

// ---- Weather and the time slider ---------------------------------------------------------------------------------------------------------------

function page() {
  const requests: string[] = [];
  class Node {
    public children: Node[] = [];
    public parentNode: Node | undefined;
    public attributes = new Map<string, string>();
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
    public addEventListener(): void {}
    public getContext(): null { return null; }
    public all(): Node[] { return [this, ...this.children.flatMap((child) => child.all())]; }
  }
  const record = (kind: string) => (url: unknown) => { requests.push(`${kind} ${String(url)}`); return Promise.reject(new Error('offline')); };
  const window: Record<string, unknown> = {};
  const context: Record<string, unknown> = {
    window, document: { head: new Node('head'), createElement: (tag: string) => new Node(tag), createElementNS: (_ns: string, tag: string) => new Node(tag) },
    console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Map, Object, Array, Number, String, Boolean, Error, isFinite,
    fetch: record('fetch'), XMLHttpRequest: class { public open(_m: string, url: string) { requests.push(`xhr ${url}`); } public send() {} },
    WebSocket: class { public constructor(url: string) { requests.push(`websocket ${url}`); } },
    EventSource: class { public constructor(url: string) { requests.push(`eventsource ${url}`); } },
    Image: class { public set src(url: string) { requests.push(`image ${url}`); } }
  };
  vm.createContext(context);
  new vm.Script(readFileSync(path.join(REPO, 'media', 'staff', 'copMap.js'), 'utf8'), { filename: 'copMap.js' }).runInContext(context);
  return { api: window.nearCopMap as Record<string, any>, container: new Node('div'), requests };
}

function envPicture(): { picture: CopPicture; pack: EnvPack } {
  const scenario = starter();
  const read = readEnvPack(committed(), { frame: scenario.region.frame, scenario: scenario.id });
  assert.ok(read.ok);
  const picture = buildCopPicture({ marking: scenario.marking, frame: scenario.region.frame, geography: syntheticGeography(scenario), scenario, layers: [], environment: pictureEnvironment(read.value) });
  return { picture, pack: read.value };
}

test('the time slider picks the weather frame valid at the clock, none outside the forecast, and none before the run when replaying as known', () => {
  const grid: WeatherGrid = {
    format: 'near-env-weather', version: 1, bounds: [0, 0, 0.1, 0.1], width: 2, height: 2, model: { name: 'Test model', runAt: '2027-05-17T18:00:00.000Z' }, stepHours: 6,
    variables: [{ id: 'wind-speed', units: 'm/s' }, { id: 'wind-from', units: 'degrees' }],
    frames: ['2027-05-18T00:00:00.000Z', '2027-05-18T06:00:00.000Z', '2027-05-18T12:00:00.000Z'].map((validAt) => ({ validAt, values: { 'wind-speed': [5, 5, 5, 5], 'wind-from': [240, 240, 240, 240] } }))
  };
  const layer = weatherLayer(grid);
  const t = (iso: string) => Date.parse(iso);
  const pick = (iso: string, mode: 'valid' | 'known' = 'valid') => weatherFrameAt(layer, t(iso), mode)?.validFrom;
  assert.equal(pick('2027-05-17T23:59:59.000Z'), undefined, 'before the first valid time');
  assert.equal(pick('2027-05-18T00:00:00.000Z'), t('2027-05-18T00:00:00.000Z'));
  assert.equal(pick('2027-05-18T05:59:59.000Z'), t('2027-05-18T00:00:00.000Z'));
  assert.equal(pick('2027-05-18T06:00:00.000Z'), t('2027-05-18T06:00:00.000Z'), 'a frame holds until the next one starts');
  assert.equal(pick('2027-05-18T17:59:00.000Z'), t('2027-05-18T12:00:00.000Z'), 'the last frame holds for stepHours');
  assert.equal(pick('2027-05-18T18:00:00.000Z'), undefined, 'never stretched past the forecast');
  assert.equal(layer.frames[1].label, 'Weather valid 2027-05-18 06:00Z to 2027-05-18 12:00Z, Test model run 2027-05-17 18:00Z (+12 h)');

  // As known: a frame valid before the run (a hindcast) is not known until the run.
  const early = weatherLayer({ ...grid, model: { ...grid.model, runAt: '2027-05-18T03:00:00.000Z' } });
  assert.equal(weatherFrameAt(early, t('2027-05-18T01:00:00.000Z'), 'valid')?.validFrom, t('2027-05-18T00:00:00.000Z'));
  assert.equal(weatherFrameAt(early, t('2027-05-18T01:00:00.000Z'), 'known'), undefined, 'not yet run');
  assert.equal(weatherFrameAt(early, t('2027-05-18T04:00:00.000Z'), 'known')?.validFrom, t('2027-05-18T00:00:00.000Z'));

  // The page applies the same rule as the host, at every hour of the bundled forecast and around it.
  const { api } = page();
  const { picture } = envPicture();
  const weather = picture.environment!.weather!;
  for (let hour = -30; hour <= 100; hour += 1) {
    const at = weather.frames[0].validFrom + hour * 3_600_000 + 1;
    for (const mode of ['valid', 'known'] as const) assert.equal(api.weatherFrameAt(weather, at, mode)?.validFrom, weatherFrameAt(weather, at, mode)?.validFrom, `${hour} h ${mode}`);
  }
});

test('the bundled forecast covers the inject script\'s window and follows the scenario: morning fog over the strait, a rain front with rough sea', () => {
  const scenario = starter();
  const script = parseInjectScript(readFileSync(path.join(REPO, 'resources', 'staff', 'scenarios', 'iron-lantern.sim.jsonl'), 'utf8'), scenario);
  assert.ok(script.ok);
  const dDay = Date.parse(script.value.exercise.dDay);
  const { picture } = envPicture();
  const weather = picture.environment!.weather!;
  const start = dDay + script.value.window.from * 60_000, end = dDay + script.value.window.to * 60_000;
  for (let at = start; at < end; at += 3_600_000) assert.ok(weatherFrameAt(weather, at, 'valid'), `a frame at ${new Date(at).toISOString()}`);
  assert.ok(weather.runAt <= start, 'the run comes before the window, so as known shows it too');
  const kinds = new Set(weather.frames.flatMap((frame) => frame.cells.map((cell) => cell[1])));
  assert.deepEqual([...kinds].sort(), ['fog', 'rain', 'rough-sea']);
  assert.ok(picture.time && picture.time.min <= start && picture.time.max >= end, 'the slider spans the forecast');
});

test('on the COP map the terrain and weather are layers a person toggles; the slider moves the weather; nothing is fetched (SVG and MapLibre)', async () => {
  const { api, container, requests } = page();
  const { picture } = envPicture();
  const ids = picture.layers.filter((layer) => layer.kind === 'environment').map((layer) => layer.id);
  assert.deepEqual(ids, [ENV_LAYERS.hillshade, ENV_LAYERS.contours, ENV_LAYERS.weather]);
  assert.ok(picture.layers.filter((layer) => layer.kind === 'environment').every((layer) => layer.simulated && layer.owner.startsWith('j2 geoint-analyst')), 'synthetic data carries the SIM badge; the J2 geoint-analyst owns the settings');
  assert.equal(picture.geography!.features.some((feature) => feature.properties.kind === 'contour'), true, 'the hand-drawn rings are still in the plain geography');

  const view = await api.mount(container, { renderer: 'svg' });
  view.setPicture(picture);
  const fogFrame = picture.environment!.weather!.frames.find((frame) => frame.cells.some((cell) => cell[1] === 'fog'))!;
  view.setTime(fogFrame.validFrom + 60_000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const count = (kind: string) => container.all().filter((node) => node.getAttribute('class') === `cop-map-env-${kind}`).length;
  assert.ok(count('hillshade') > 0 && count('contour') > 0 && count('coastline') > 0, 'hillshade, contours and coastline drawn');
  assert.equal(count('wind'), 0, 'weather is off until a person turns it on');
  const line = () => container.all().find((node) => node.className === 'cop-map-env')!;
  assert.match(line().textContent, /Nothing in this pack is a real place/, 'the attribution shows while a pack layer is on');
  view.setLayerVisible(ENV_LAYERS.weather, true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(count('wind'), picture.environment!.weather!.points.length, 'one arrow per grid point');
  assert.equal(count('fog'), fogFrame.cells.filter((cell) => cell[1] === 'fog').length, 'the fog of the frame at the clock');
  assert.ok(line().textContent.startsWith(fogFrame.label), line().textContent);
  view.setTime(picture.environment!.weather!.frames[0].validFrom - 3_600_000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(count('wind'), 0);
  assert.match(line().textContent, /^No weather for this time: the forecast covers 2027-05-18 00:00Z to 2027-05-21 12:00Z\./);
  view.setLayerVisible(ENV_LAYERS.hillshade, false);
  view.setLayerVisible(ENV_LAYERS.contours, false);
  view.setLayerVisible(ENV_LAYERS.weather, false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(count('hillshade') + count('contour'), 0, 'toggled off');
  assert.equal(line().hidden, true, 'no pack layer on, no line');
  view.destroy();

  // MapLibre: the terrain and weather are GeoJSON sources in the same style, which names no tile, raster, glyph or sprite.
  const data = new Map<string, { features: Array<{ properties: Record<string, unknown> }> }>();
  let style = '';
  class FakeMap {
    public constructor(options: { style: unknown }) { style = JSON.stringify(options.style); setTimeout(() => this.handlers.get('load')?.forEach((fn) => fn()), 0); }
    private handlers = new Map<string, Array<() => void>>();
    public addControl(): void {}
    public on(type: string, fn: () => void): void { this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]); }
    public once(type: string, fn: () => void): void { this.on(type, fn); }
    public getSource(id: string) { return { setData: (value: never) => { data.set(id, value); } }; }
    public fitBounds(): void {}
    public setFilter(): void {}
    public setPaintProperty(): void {}
    public remove(): void {}
  }
  const map = await api.mount(container, { renderer: 'auto', libraries: { maplibregl: { Map: FakeMap, NavigationControl: class {} } } });
  assert.equal(map.renderer, 'maplibre');
  assert.doesNotMatch(style, /https?:|glyphs|sprite|"tiles"|raster|"url"|pmtiles/i);
  map.setPicture(picture);
  map.setLayerVisible(ENV_LAYERS.weather, true);
  map.setTime(fogFrame.validFrom);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const terrain = data.get('terrain')!.features;
  assert.ok(terrain.some((feature) => feature.properties.kind === 'hillshade') && terrain.some((feature) => feature.properties.kind === 'contour'));
  assert.ok(data.get('weather')!.features.some((feature) => feature.properties.kind === 'fog'));
  map.destroy();
  assert.deepEqual(requests, [], 'no request at all: the layers come in the picture');
});

// ---- Loading in the extension -------------------------------------------------------------------------------------------------------------------

test('the COP picture of a project with the starter scenario carries the bundled pack; a tampered pack is refused with the reason and the map still draws', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-env-'));
  mkdirSync(path.join(root, SCENARIO_DIR), { recursive: true });
  writeFileSync(path.join(root, SCENARIO_DIR, 'scenario.json'), readFileSync(path.join(REPO, 'resources', 'staff', 'scenarios', 'iron-lantern.json')));
  const picture = await loadCopPicture(root, { section: 'j2', roster: [] });
  assert.ok(picture.environment, 'the bundled pack is drawn');
  assert.equal(picture.geography!.features.some((feature) => feature.properties.kind === 'contour'), false, 'the DEM\'s contours replace the hand-drawn rings');

  const envDir = mkdtempSync(path.join(tmpdir(), 'near-ai-env-dir-'));
  cpSync(PACK_DIR, path.join(envDir, 'iron-lantern'), { recursive: true });
  const demFile = path.join(envDir, 'iron-lantern', 'dem.json');
  writeFileSync(demFile, readFileSync(demFile, 'utf8').replace(/"heights":\[\n-(\d)/, (_, digit: string) => `"heights":[\n-${digit === '9' ? '8' : '9'}`), 'utf8');
  const refused = await loadCopPicture(root, { section: 'j2', roster: [], envDir });
  assert.equal(refused.environment, undefined);
  const note = refused.layers.find((layer) => layer.kind === 'environment')!;
  assert.match(note.note!, /^Not shown: the environment pack was refused: dem\.json: its SHA-256 does not match/);
  assert.ok(refused.geography!.features.some((feature) => feature.properties.kind === 'contour'), 'the hand-drawn geography stays');

  assert.equal(await scenarioEnvironment(starter(), mkdtempSync(path.join(tmpdir(), 'near-ai-env-none-'))), undefined, 'no pack, no layers and no complaint');
  assert.equal(await scenarioEnvironment({ ...starter(), id: '../escape' }, envDir), undefined, 'a scenario id never becomes a path outside the pack folder');
});

// ---- The pack builder --------------------------------------------------------------------------------------------------------------------------

test('the pack builder refuses in CI and without GDAL, and its parsing of GDAL output makes a valid real-data pack', () => {
  const script = path.join(REPO, 'scripts', 'build-env-pack.mjs');
  const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [script, '--out', path.join(tmpdir(), 'never-written')], { env, encoding: 'utf8' });
  const ci = run({ PATH: process.env.PATH, CI: 'true' });
  assert.equal(ci.status, 2);
  assert.match(ci.stderr, /never in CI/);
  const empty = mkdtempSync(path.join(tmpdir(), 'near-ai-no-gdal-'));
  const noGdal = run({ PATH: empty });
  assert.equal(noGdal.status, 2);
  assert.match(noGdal.stderr, /GDAL is not installed/);

  const asc = 'ncols 3\nnrows 2\nxllcorner 10.0\nyllcorner 50.0\ncellsize 0.01\nNODATA_value -9999\n0 12.4 30\n-9999 5 7.6\n';
  const grid = parseAsciiGrid(asc);
  const dem = demFromAsciiGrid(grid);
  [10.005, 50.005, 10.025, 50.015].forEach((expected, index) => assert.ok(Math.abs(dem.bounds[index] - expected) < 1e-9, 'the bounds are the cell centres'));
  assert.deepEqual(dem.heights, [0, 12, 30, -32768, 5, 8]);
  assert.throws(() => parseAsciiGrid('ncols 3\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 1\n1 2 3\n'), /expected 6/);
  assert.throws(() => parseAsciiGrid('ncols 3000\nnrows 3000\nxllcorner 0\nyllcorner 0\ncellsize 1\n'), /at most/);
  assert.equal(gribTime('1779062400'), '2026-05-18T00:00:00.000Z');
  assert.equal(gribTime('  1779062400 sec UTC'), '2026-05-18T00:00:00.000Z');
  assert.deepEqual([0, 0.05, 0.3, 1, 2, 3, 5, 8, 12, 20].map(douglasSeaState), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  const band = (element: string, values: number[], validTime = '2026-05-18T00:00:00.000Z') => ({ element, refTime: '2026-05-17T18:00:00.000Z', validTime, grid: { ...grid, values } });
  const weather = weatherFromBands('Example model', [band('UGRD', [3, 0, 0, 0, 0, -4]), band('VGRD', [4, 5, 0, 0, -1, 0]), band('VIS', [500, 20000, 20000, 20000, 20000, 20000]), band('PRATE', [0.001, 0, 0, 0, 0, 0])], 3);
  assert.deepEqual(weather.frames[0].values['wind-speed']!.slice(0, 2), [5, 5]);
  assert.equal(weather.frames[0].values['wind-from']![1], 180, 'a wind blowing north comes from the south');
  assert.equal(weather.frames[0].values['wind-from']![5], 90, 'a wind blowing west comes from the east');
  assert.equal(weather.frames[0].values.visibility![0], 0.5);
  assert.equal(weather.frames[0].values.precipitation![0], 3.6);
  assert.throws(() => weatherFromBands('m', [band('UGRD', [1, 1, 1, 1, 1, 1]), { ...band('VGRD', [1, 1, 1, 1, 1, 1]), refTime: '2026-05-18T00:00:00.000Z' }], 3), /one model run/);
  const files = writeEnvPack({ id: 'built', title: 'Built from GDAL output', data: 'real', bounds: [10, 50, 10.03, 50.02], attribution: ['Elevation and forecast: Example providers'], licence: 'CC BY 4.0', sources: [{ name: 'Example', licence: 'CC BY 4.0' }], dem, coastline: { type: 'FeatureCollection', features: [] }, weather });
  const read = readEnvPack(bytes(files));
  assert.ok(read.ok, !read.ok ? read.problems.join('\n') : '');
  assert.ok(schemaCheck('weather')(JSON.parse(files['weather.json'])));
});
