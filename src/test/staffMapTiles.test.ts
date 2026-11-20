// The COP map's bundled tiles (research note "COP map: photo-realistic imagery, 3D globe, 3D terrain and topographic base"): every tile folder holds
// exactly what its index lists, with matching sizes and hashes; the index format refuses anything that could leave its folder or is the wrong kind
// of file; the Terrarium heights round-trip through MapLibre's own decoding; the imagery and heights are made again from the seed pixel for pixel;
// and the host gives the page tile addresses only for folders that pass every check.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  checkTileIndex, decodePng, DEM_BOX, encodePng, ENV_TILE_SETS, heightTile, IRON_LANTERN_SEED, packImageryRenderer, packTileSets, pixelDigest, readEnvPack,
  renderImagery, syntheticEnvPack, terrariumDecode, terrariumEncode, tileFile, tileProblem, TILE_LIMITS, writeEnvPack, writeTileIndex
} from '../domain/staff/env';
import type { TileIndex } from '../domain/staff/env';
import { parseScenarioText } from '../domain/staff/scenario';
import { checkTileFolder, copBasemap, GLOBE_DIR } from '../staff/mapTiles';
import { BUNDLED_ENV_DIR } from '../staff/envPack';

const REPO = path.resolve(__dirname, '..', '..');
const PACK_DIR = path.join(REPO, 'resources', 'staff', 'env', 'iron-lantern');
const TILES_DIR = path.join(PACK_DIR, 'tiles');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function starter() {
  const parsed = parseScenarioText(readFileSync(path.join(REPO, 'resources', 'staff', 'scenarios', 'iron-lantern.json'), 'utf8'));
  assert.ok(parsed.ok);
  return parsed.value;
}

function files(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => { const file = path.join(dir, name); return statSync(file).isDirectory() ? files(file, base) : [path.relative(base, file).split(path.sep).join('/')]; });
}

function index(dir: string): TileIndex {
  const checked = checkTileIndex(JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8')));
  assert.ok(checked.ok, checked.ok ? '' : checked.problems.join('\n'));
  return checked.value;
}

/** Every file of a folder is in its index (or one of `extra`), with the size and hash the index records, and every listed tile is there. */
function folderMatches(dir: string, extra: string[]): number {
  const idx = index(dir);
  const listed = new Set(['index.json', ...extra]);
  let count = 0;
  for (const [setId, set] of Object.entries(idx.sets)) for (const entry of set.tiles) {
    const name = tileFile(setId, set, entry[0]);
    listed.add(name);
    assert.equal(tileProblem(setId, set, entry, readFileSync(path.join(dir, name))), undefined, name);
    count += 1;
  }
  for (const name of files(dir)) assert.ok(listed.has(name), `${name} is not in the index`);
  return count;
}

test('every bundled globe tile is in media/map/globe/index.json with its size and hash, nothing else is there, and DATA.json pins the index and credits each set', () => {
  const count = folderMatches(GLOBE_DIR, ['DATA.json']);
  assert.equal(count, 1365 + 341, 'Blue Marble z0-5 and Natural Earth z0-4');
  const data = JSON.parse(readFileSync(path.join(GLOBE_DIR, 'DATA.json'), 'utf8'));
  assert.equal(data.indexSha256, sha(readFileSync(path.join(GLOBE_DIR, 'index.json'))));
  for (const set of data.sets) {
    assert.ok(set.credit && set.terms && /^https:\/\//.test(set.sourceUrl) && /^[0-9a-f]{64}$/.test(set.sourceSha256), set.id);
  }
  assert.match(data.sets.find((set: { id: string }) => set.id === 'blue-marble').credit, /^NASA Earth Observatory$/);
  assert.match(data.sets.find((set: { id: string }) => set.id === 'blue-marble').terms, /endorsement/);
  assert.match(data.sets.find((set: { id: string }) => set.id === 'natural-earth').terms, /public domain/);
  // The committed index is in the one written form (sorted, one tile per line).
  const idx = index(GLOBE_DIR);
  assert.equal(writeTileIndex(Object.entries(idx.sets)), readFileSync(path.join(GLOBE_DIR, 'index.json'), 'utf8'));
});

test('every tile of the IRON LANTERN pack is in tiles/index.json, nothing else is there, and the manifest pins the index', () => {
  const count = folderMatches(TILES_DIR, []);
  assert.ok(count > 500 && count < 1500, `${count} tiles`);
  const manifest = JSON.parse(readFileSync(path.join(PACK_DIR, 'manifest.json'), 'utf8'));
  const bytes = readFileSync(path.join(TILES_DIR, 'index.json'));
  assert.deepEqual(manifest.tiles, { path: 'tiles/index.json', sha256: sha(bytes), bytes: bytes.length });
  assert.deepEqual(Object.keys(index(TILES_DIR).sets), [...ENV_TILE_SETS]);
  assert.equal(writeTileIndex(Object.entries(index(TILES_DIR).sets)), bytes.toString('utf8'));
});

test('the tile index refuses paths that could leave the folder, tiles outside the zoom range or bounds, oversized tiles and unknown sets', () => {
  const good = { format: 'near-map-tiles', version: 1, sets: { imagery: { format: 'webp', minzoom: 5, maxzoom: 6, bounds: [-124.1, -49.4, -122.7, -48.4], tiles: [['5/5/20', 100, 'a'.repeat(64), 'b'.repeat(16)]] } } };
  assert.ok(checkTileIndex(good, { sets: ENV_TILE_SETS }).ok);
  const withTile = (tile: unknown[], extra: Record<string, unknown> = {}) => ({ ...good, sets: { imagery: { ...good.sets.imagery, tiles: [tile], ...extra } } });
  const refused = (value: unknown, pattern: RegExp, options = {}) => {
    const result = checkTileIndex(value, options);
    assert.ok(!result.ok && result.problems.some((problem) => pattern.test(problem)), `${JSON.stringify(value).slice(0, 120)}: ${result.ok ? 'accepted' : result.problems.join(' ')}`);
  };
  for (const evil of ['../5/5/20', '/5/5/20', '5/5/20/..', '5\\5\\20', '5/5/20.webp', 'C:/5/5/20', '05/5/20', '5/5/ 20']) refused(withTile([evil, 100, 'a'.repeat(64), 'b'.repeat(16)]), /never leave its folder/);
  refused(withTile(['7/20/80', 100, 'a'.repeat(64), 'b'.repeat(16)]), /outside the set's zoom range/);
  refused(withTile(['5/0/0', 100, 'a'.repeat(64), 'b'.repeat(16)]), /outside the set's bounds/);
  refused(withTile(['5/5/20', TILE_LIMITS.tileBytes + 1, 'a'.repeat(64), 'b'.repeat(16)]), /must be 8 to/);
  refused(withTile(['5/5/20', 100, 'A'.repeat(64), 'b'.repeat(16)]), /SHA-256/);
  refused({ ...good, sets: { scripts: good.sets.imagery } }, /not a set this folder may have/, { sets: ENV_TILE_SETS });
  refused(withTile(['5/5/20', 100, 'a'.repeat(64), 'b'.repeat(16)], { format: 'svg' }), /webp or png/);
  refused({ ...good, version: 2 }, /not supported/);
});

test('a tile is checked by size, then its magic bytes, then its hash', () => {
  const png = encodePng(new Uint8Array(4 * 4 * 3), 4, 4, 3);
  const entry = ['5/5/20', png.length, sha(png), 'b'.repeat(16)] as const;
  assert.equal(tileProblem('relief', { format: 'png' }, entry, png), undefined);
  assert.match(tileProblem('relief', { format: 'webp' }, entry, png)!, /not a WEBP file/);
  const html = new TextEncoder().encode('<script>alert(1)</script>'.padEnd(png.length, ' '));
  assert.match(tileProblem('relief', { format: 'png' }, [entry[0], html.length, sha(html), entry[3]], html)!, /not a PNG file/);
  const changed = Uint8Array.from(png); changed[changed.length - 5] ^= 1;
  assert.match(tileProblem('relief', { format: 'png' }, entry, changed)!, /SHA-256 does not match/);
  assert.match(tileProblem('relief', { format: 'png' }, entry, png.subarray(1))!, /bytes, but the index records/);
});

test('Terrarium heights round-trip through MapLibre\'s own factors, the PNG writer round-trips, and the 3D surface has no height below sea level', () => {
  for (let metres = -500; metres <= 9000; metres += 1) {
    const [r, g, b] = terrariumEncode(metres);
    assert.equal(terrariumDecode(r, g, b), metres);
  }
  for (const metres of [-12.25, 0.5, 301.75]) { const [r, g, b] = terrariumEncode(metres, 0.25); assert.equal(terrariumDecode(r, g, b), metres); }
  const pixels = Uint8Array.from({ length: 7 * 5 * 3 }, (_, i) => (i * 37) % 256);
  const decoded = decodePng(encodePng(pixels, 7, 5, 3));
  assert.equal(decoded.width, 7);
  assert.deepEqual([...decoded.rgba.filter((_, i) => i % 4 !== 3)], [...pixels]);
  const idx = index(TILES_DIR);
  let lowest = Infinity, highest = -Infinity;
  for (const entry of idx.sets.terrain.tiles) {
    const { rgba } = decodePng(readFileSync(path.join(TILES_DIR, tileFile('terrain', idx.sets.terrain, entry[0]))));
    for (let p = 0; p < rgba.length; p += 4) { const h = terrariumDecode(rgba[p], rgba[p + 1], rgba[p + 2]); lowest = Math.min(lowest, h); highest = Math.max(highest, h); }
  }
  assert.equal(lowest, 0, 'the sea is flat at 0 m on the 3D surface');
  assert.ok(highest > 250, `Harrow Ridge stands up (${highest} m)`);
  let deepest = Infinity;
  for (const entry of idx.sets.relief.tiles.filter((tile) => tile[0].startsWith('8/'))) {
    const { rgba } = decodePng(readFileSync(path.join(TILES_DIR, tileFile('relief', idx.sets.relief, entry[0]))));
    for (let p = 0; p < rgba.length; p += 4) deepest = Math.min(deepest, terrariumDecode(rgba[p], rgba[p + 1], rgba[p + 2]));
  }
  assert.ok(deepest < -40, `the relief keeps the sea floor (${deepest} m)`);
});

test('the seed draws the same pixels again: a sample of deep-zoom imagery tiles and every height tile match their pixel digests', () => {
  const scenario = starter();
  const idx = index(TILES_DIR);
  const tilesEntry = readFileSync(path.join(TILES_DIR, 'index.json'));
  const files = syntheticEnvPack(scenario, { seed: IRON_LANTERN_SEED, tiles: { path: 'tiles/index.json', sha256: sha(tilesEntry), bytes: tilesEntry.length } })!;
  const pack = { dem: JSON.parse(files['dem.json']), coastline: JSON.parse(files['coastline.geojson']), landcover: JSON.parse(files['landcover.geojson']) };
  const sets = packTileSets(scenario.region.frame!, DEM_BOX, JSON.parse(files['manifest.json']).bounds);
  for (const set of sets) {
    assert.deepEqual([set.minzoom, set.maxzoom, set.bounds], [idx.sets[set.id].minzoom, idx.sets[set.id].maxzoom, [...idx.sets[set.id].bounds]], set.id);
  }
  const detail = idx.sets['imagery-detail'].tiles.filter((entry) => entry[0].startsWith('13/'));
  const chosen = new Map([detail[0], detail[Math.floor(detail.length / 2)], detail[detail.length - 1]].map((entry) => [entry[0], entry[3]]));
  const renderer = packImageryRenderer(scenario, pack, IRON_LANTERN_SEED)!;
  let drawn = 0;
  renderImagery(renderer, sets, (set, z, x, y, rgba) => {
    const want = chosen.get(`${z}/${x}/${y}`);
    if (set.id !== 'imagery-detail' || !want) return;
    drawn += 1;
    assert.equal(pixelDigest(rgba), want, `imagery-detail ${z}/${x}/${y}`);
  }, (setId, z, x, y) => setId === 'imagery-detail' && chosen.has(`${z}/${x}/${y}`));
  assert.equal(drawn, chosen.size);
  for (const setId of ['terrain', 'relief']) for (const entry of idx.sets[setId].tiles) {
    const [z, x, y] = entry[0].split('/').map(Number);
    assert.equal(pixelDigest(heightTile(scenario.region.frame!, pack.dem, z, x, y, setId === 'terrain').rgba), entry[3], `${setId} ${entry[0]}`);
  }
});

test('a version 1 pack is still read, and a version 1 manifest may not carry land cover or tiles', () => {
  const scenario = starter();
  const v2 = syntheticEnvPack(scenario, { seed: IRON_LANTERN_SEED })!;
  const read = readEnvPack(Object.fromEntries(Object.entries(v2).map(([name, text]) => [name, Buffer.from(text)])));
  assert.ok(read.ok);
  const v1 = writeEnvPack({ ...read.value.manifest, dem: read.value.dem, coastline: read.value.coastline });
  assert.equal(JSON.parse(v1['manifest.json']).version, 1);
  assert.ok(readEnvPack(Object.fromEntries(Object.entries(v1).map(([name, text]) => [name, Buffer.from(text)]))).ok, 'version 1 is still valid');
  const manifest = JSON.parse(v1['manifest.json']);
  manifest.tiles = { path: 'tiles/index.json', sha256: 'a'.repeat(64), bytes: 10 };
  const refused = readEnvPack({ ...Object.fromEntries(Object.entries(v1).map(([name, text]) => [name, Buffer.from(text)])), 'manifest.json': Buffer.from(JSON.stringify(manifest)) });
  assert.ok(!refused.ok && refused.problems.some((problem) => /tiles need a version 2 pack/.test(problem)));
  manifest.version = 2; manifest.tiles.path = '../../etc/index.json';
  const traversal = readEnvPack({ ...Object.fromEntries(Object.entries(v1).map(([name, text]) => [name, Buffer.from(text)])), 'manifest.json': Buffer.from(JSON.stringify(manifest)) });
  assert.ok(!traversal.ok && traversal.problems.some((problem) => /path must be "tiles\/index.json"/.test(problem)));
});

test('the host gives the page tile addresses only after the folders pass: the bundled ones do, a changed tile or index refuses its folder with the reason', async () => {
  const scenario = starter();
  const uri = (dir: string) => `https://file+.vscode-resource.vscode-cdn.net${dir}`;
  const basemap = await copBasemap(uri, scenario);
  assert.deepEqual(basemap.problems, []);
  assert.equal(basemap.globe?.imagery?.tiles, `${uri(GLOBE_DIR)}/blue-marble/{z}/{x}/{y}.webp`);
  assert.equal(basemap.globe?.credit.imagery, 'NASA Earth Observatory');
  assert.equal(basemap.frame?.terrain?.tiles, `${uri(TILES_DIR)}/terrain/{z}/{x}/{y}.png`);
  assert.equal(basemap.frame?.landcover, `${uri(PACK_DIR)}/landcover.geojson`);
  assert.equal(path.join(BUNDLED_ENV_DIR, 'iron-lantern'), PACK_DIR);
  const temp = mkdtempSync(path.join(tmpdir(), 'near-map-tiles-'));
  try {
    const env = path.join(temp, 'env');
    cpSync(PACK_DIR, path.join(env, 'iron-lantern'), { recursive: true });
    const idx = index(TILES_DIR);
    const victim = path.join(env, 'iron-lantern', 'tiles', tileFile('relief', idx.sets.relief, idx.sets.relief.tiles[3][0]));
    const bytes = readFileSync(victim); bytes[bytes.length - 6] ^= 1; writeFileSync(victim, bytes);
    const changed = await copBasemap(uri, scenario, { env });
    assert.equal(changed.frame, undefined, 'no terrain address from a changed folder');
    assert.ok(changed.problems.some((problem) => /SHA-256 does not match/.test(problem)), changed.problems.join(' '));
    assert.ok(changed.globe?.imagery, 'the world imagery still loads');
    const tilesDir = path.join(env, 'iron-lantern', 'tiles');
    writeFileSync(path.join(tilesDir, 'index.json'), readFileSync(path.join(tilesDir, 'index.json'), 'utf8').replace('"imagery"', '"imagery" '));
    const edited = await checkTileFolder(tilesDir, JSON.parse(readFileSync(path.join(PACK_DIR, 'manifest.json'), 'utf8')).tiles.sha256, { sets: ENV_TILE_SETS });
    assert.ok(!edited.ok && /does not match the hash its record holds/.test(edited.problems[0]));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
