#!/usr/bin/env node
// Writes the synthetic environment pack of a bundled scenario (WP-ENV, pack version 2): a DEM, a coastline, a weather forecast and land cover for its
// exercise frame, and its map tiles (photo-like imagery, 3D terrain heights and relief heights), all made deterministically from a seed by
// src/domain/staff/env/. Needs no GDAL and no network. Run `npm run compile` first.
//
//   node scripts/generate-env-pack.mjs                  write the text files of resources/staff/env/iron-lantern/ with the bundled seed (keeps the tiles)
//   node scripts/generate-env-pack.mjs --tiles          also make every tile again and tiles/index.json (needs the devDependency @jsquash/webp)
//   node scripts/generate-env-pack.mjs --seed 7         another seed (a different pack; the manifest records the seed)
//   node scripts/generate-env-pack.mjs --check          write nothing; fail if the committed text files or tile index differ from what the seed makes,
//                                                       or if a tile's bytes do not match the index, or a file in tiles/ is not in it
//   node scripts/generate-env-pack.mjs --check-sample N as --check, and draw N imagery tiles and every height tile again and compare their pixels
//   node scripts/generate-env-pack.mjs --check-tiles    as --check, and draw every tile again and compare its pixels (a few minutes)
//
// Pixels are compared by digest, not file bytes: two builds of the encoder may write different bytes for the same pixels (the file hashes still
// pin every shipped byte). The pack format is documented in docs/staff-env-packs.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const DIST = path.join(ROOT, 'dist', 'domain', 'staff');
if (!existsSync(path.join(DIST, 'env', 'packTiles.js'))) {
  console.error('Run `npm run compile` first: this script uses the compiled generator in dist/.');
  process.exit(2);
}
const env = require(path.join(DIST, 'env', 'index.js'));
const { parseScenarioText } = require(path.join(DIST, 'scenario.js'));

/** WebP quality of the imagery tiles: the detail zooms a little lower, as they are most of the bytes. */
export const IMAGERY_QUALITY = { imagery: 80, 'imagery-detail': 76 };

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const check = flag('--check') || flag('--check-tiles') || value('--check-sample') !== undefined;
const sample = value('--check-sample') !== undefined ? Number(value('--check-sample')) : flag('--check-tiles') ? Infinity : 0;
const seed = value('--seed') !== undefined ? Number(value('--seed')) : env.IRON_LANTERN_SEED;
if (!Number.isSafeInteger(seed)) { console.error('--seed takes a whole number.'); process.exit(2); }
if (!(sample === Infinity || (Number.isSafeInteger(sample) && sample >= 0))) { console.error('--check-sample takes a whole number.'); process.exit(2); }

const scenarioId = 'iron-lantern';
const parsed = parseScenarioText(readFileSync(path.join(ROOT, 'resources', 'staff', 'scenarios', `${scenarioId}.json`), 'utf8'));
if (!parsed.ok) { console.error(`The bundled scenario did not load: ${JSON.stringify(parsed.errors ?? parsed).slice(0, 300)}`); process.exit(1); }
const scenario = parsed.value;
const frame = scenario.region.frame;
const out = path.join(ROOT, 'resources', 'staff', 'env', scenarioId);
const tilesDir = path.join(out, 'tiles');
const indexFile = path.join(out, env.ENV_TILE_INDEX);

/** The manifest entry of an index's bytes. */
const indexEntry = (bytes) => ({ path: env.ENV_TILE_INDEX, sha256: env.sha256Of(bytes), bytes: bytes.length });

/** Every tile of the pack, drawn: { set, z, x, y, rgba } for imagery, plus { rgb } for heights. `wanted` limits the imagery drawn. */
function drawTiles(files, wanted) {
  const pack = { dem: JSON.parse(files['dem.json']), coastline: JSON.parse(files['coastline.geojson']), landcover: JSON.parse(files['landcover.geojson']) };
  const manifest = JSON.parse(files['manifest.json']);
  const sets = env.packTileSets(frame, env.DEM_BOX, manifest.bounds);
  const renderer = env.packImageryRenderer(scenario, pack, seed);
  const tiles = [];
  env.renderImagery(renderer, sets, (set, z, x, y, rgba) => tiles.push({ set, z, x, y, rgba: new Uint8ClampedArray(rgba) }), wanted);
  return { sets, tiles, heights: (only) => sets.filter((set) => set.format === 'png').flatMap((set) => env.setTiles(set).filter(([z, x, y]) => !only || only(set.id, z, x, y)).map(([z, x, y]) => ({ set, z, x, y, ...env.heightTile(frame, pack.dem, z, x, y, set.id === 'terrain') }))) };
}

/** Files under a folder, relative, with forward slashes. */
function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => { const file = path.join(dir, name); return statSync(file).isDirectory() ? listFiles(file, base) : [path.relative(base, file).split(path.sep).join('/')]; });
}

if (flag('--tiles') && !check) {
  const { webpEncoder } = await import('./lib/webp.mjs');
  const encode = await webpEncoder();
  const first = env.syntheticEnvPack(scenario, { seed });
  const started = Date.now();
  const drawn = drawTiles(first);
  console.log(`Drew ${drawn.tiles.length} imagery tiles in ${Math.round((Date.now() - started) / 1000)} s.`);
  if (existsSync(tilesDir)) rmSync(tilesDir, { recursive: true });
  const entries = new Map(drawn.sets.map((set) => [set.id, []]));
  const write = (setId, z, x, y, format, bytes, rgba) => {
    const file = path.join(tilesDir, setId, String(z), String(x), `${y}.${format}`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    entries.get(setId).push([`${z}/${x}/${y}`, bytes.length, env.sha256Of(bytes), env.pixelDigest(rgba)]);
  };
  for (const tile of drawn.tiles) {
    const bytes = await encode({ data: tile.rgba, width: env.TILE_SIZE, height: env.TILE_SIZE }, { quality: IMAGERY_QUALITY[tile.set.id], method: 6, alpha_quality: 90 });
    write(tile.set.id, tile.z, tile.x, tile.y, 'webp', bytes, tile.rgba);
  }
  for (const tile of drawn.heights()) write(tile.set.id, tile.z, tile.x, tile.y, 'png', env.encodePng(tile.rgb, env.TILE_SIZE, env.TILE_SIZE, 3), tile.rgba);
  const index = env.writeTileIndex(drawn.sets.map((set) => [set.id, { format: set.format, minzoom: set.minzoom, maxzoom: set.maxzoom, bounds: set.bounds, tiles: entries.get(set.id) }]));
  writeFileSync(indexFile, index);
  for (const set of drawn.sets) {
    const list = entries.get(set.id);
    console.log(`  ${set.id}: ${list.length} tiles, ${list.reduce((sum, entry) => sum + entry[1], 0).toLocaleString('en-US')} bytes`);
  }
}

const committedIndex = existsSync(indexFile) ? readFileSync(indexFile) : undefined;
const files = env.syntheticEnvPack(scenario, { seed, ...(committedIndex ? { tiles: indexEntry(committedIndex) } : {}) });
if (!files) { console.error('The scenario has no frame or outline to generate a pack for.'); process.exit(1); }
const bytes = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text, 'utf8')]));
const valid = env.readEnvPack(bytes, { frame, scenario: scenarioId });
if (!valid.ok) { console.error(`The generated pack does not validate:\n${valid.problems.join('\n')}`); process.exit(1); }

if (check) {
  const problems = [];
  const differ = Object.keys(files).filter((name) => !existsSync(path.join(out, name)) || readFileSync(path.join(out, name), 'utf8') !== files[name]);
  if (differ.length) problems.push(`The committed pack differs from seed ${seed}: ${differ.join(', ')}. Run node scripts/generate-env-pack.mjs --tiles and commit the result.`);
  if (!committedIndex) problems.push('tiles/index.json is missing.');
  else {
    const index = env.checkTileIndex(JSON.parse(committedIndex.toString('utf8')), { sets: env.ENV_TILE_SETS, within: valid.value.manifest.bounds });
    if (!index.ok) problems.push(...index.problems);
    else {
      const listed = new Set(['index.json']);
      for (const [setId, set] of Object.entries(index.value.sets)) for (const entry of set.tiles) {
        const name = env.tileFile(setId, set, entry[0]);
        listed.add(name);
        const file = path.join(tilesDir, name);
        const problem = existsSync(file) ? env.tileProblem(setId, set, entry, readFileSync(file)) : `${name} is missing.`;
        if (problem) problems.push(problem);
      }
      for (const name of listFiles(tilesDir)) if (!listed.has(name)) problems.push(`tiles/${name} is not in the index.`);
      if (sample > 0 && !problems.length) {
        // Which imagery tiles to draw again: every one, or a sample spread over the detail zooms (each lower zoom is an average of thousands of
        // deepest-zoom tiles, so --check-tiles covers those) picked by a hash of the index, so a run is repeatable.
        const imagery = Object.entries(index.value.sets).filter(([, set]) => set.format === 'webp').flatMap(([setId, set]) => set.tiles.map((entry) => [setId, entry]));
        const pool = sample === Infinity ? imagery : imagery.filter(([setId, entry]) => setId === 'imagery-detail' && Number(entry[0].split('/')[0]) >= 12);
        const order = pool.map((item, i) => [env.sha256Of(`${item[1][0]}|${i}`), item]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((pair) => pair[1]);
        const chosen = new Map(order.slice(0, sample === Infinity ? order.length : sample).map(([setId, entry]) => [`${setId}|${entry[0]}`, entry]));
        const drawn = drawTiles(files, (setId, z, x, y) => chosen.has(`${setId}|${z}/${x}/${y}`));
        const seen = new Set();
        for (const tile of drawn.tiles) {
          const key = `${tile.set.id}|${tile.z}/${tile.x}/${tile.y}`;
          const entry = chosen.get(key);
          if (!entry) continue;
          seen.add(key);
          if (env.pixelDigest(tile.rgba) !== entry[3]) problems.push(`${env.tileFile(tile.set.id, tile.set, entry[0])}: its pixels differ from what seed ${seed} draws.`);
        }
        for (const key of chosen.keys()) if (!seen.has(key)) problems.push(`${key} was not drawn again.`);
        for (const tile of drawn.heights()) {
          const entry = index.value.sets[tile.set.id].tiles.find((candidate) => candidate[0] === `${tile.z}/${tile.x}/${tile.y}`);
          if (!entry) problems.push(`${tile.set.id} ${tile.z}/${tile.x}/${tile.y} is not in the index.`);
          else if (env.pixelDigest(tile.rgba) !== entry[3]) problems.push(`${env.tileFile(tile.set.id, tile.set, entry[0])}: its heights differ from what seed ${seed} makes.`);
        }
        console.log(`Drew ${chosen.size} imagery tiles and every height tile again.`);
      }
    }
  }
  if (problems.length) { console.error(problems.slice(0, 20).join('\n')); process.exit(1); }
  console.log(`The committed pack matches seed ${seed}.`);
} else {
  mkdirSync(out, { recursive: true });
  let total = 0;
  for (const [name, text] of Object.entries(files)) { writeFileSync(path.join(out, name), text); total += Buffer.byteLength(text); }
  console.log(`Wrote ${Object.keys(files).length} files (${total.toLocaleString('en-US')} bytes) to ${path.relative(ROOT, out)} with seed ${seed}${committedIndex ? ', with the tile index' : ', without tiles (run with --tiles to make them)'}.`);
}
