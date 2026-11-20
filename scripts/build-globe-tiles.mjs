#!/usr/bin/env node
// Builds the globe's bundled world tiles (media/map/globe/) from a downloaded world image. A developer tool: it is never run in CI or by the
// extension, makes no network request and needs no GDAL. Its outputs are committed with their hashes, and the COP map loads them from the extension.
//
//   node scripts/build-globe-tiles.mjs --source <file.jpg> --expect-sha256 <hex> --set blue-marble|natural-earth --max-zoom N [--quality Q] [--top-quality Q]
//
// It refuses a source whose SHA-256 is not the one given, so the tiles are always made from the file recorded in media/map/globe/DATA.json. The
// source is an equirectangular (plate carree) world image. Each zoom samples a box-filtered copy of it no smaller than the zoom's world width, with
// bilinear sampling at every tile pixel's centre in world-pixel coordinates (Web Mercator, latitudes to +/-85.051129), so tile edges meet and the same
// source always gives the same pixels. Tiles are 256 px WebP (@jsquash/webp, method 6, a fixed quality; --top-quality for the highest zoom).
//
// It writes media/map/globe/<set>/<z>/<x>/<y>.webp, then media/map/globe/index.json (every tile's bytes, file SHA-256 and a digest of its pixels
// before encoding) and media/map/globe/DATA.json (sources, terms, credit, parameters and the index's hash). It fails when the set's folder holds a
// file it did not write, so a stale tile can never ship unlisted. Decoding uses @jsquash/jpeg (MozJPEG in WebAssembly, Apache-2.0), also a build-time devDependency;
// a 21600x10800 source needs about 2 GB of memory.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDev, webpEncoder } from './lib/webp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'media', 'map', 'globe');
const MAX_LAT = 85.051129;
const TILE = 256;
const METHOD = 6;

/** What each set is: where its source comes from, its terms and the credit shown on the map. The order here is the order in the index. */
const SETS = {
  'blue-marble': {
    name: 'NASA Blue Marble: Next Generation, topography and bathymetry, August 2004',
    sourceUrl: 'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/august/world.topo.bathy.200408.3x21600x10800.jpg',
    sourceFile: 'world.topo.bathy.200408.3x21600x10800.jpg',
    page: 'https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/',
    terms: 'NASA content is generally not subject to copyright in the United States (https://www.nasa.gov/nasa-brand-center/images-and-media/). It must not be used to explicitly or implicitly convey NASA\'s endorsement, and NASA logos are not used. The Blue Marble page asks: "Anyone using or republishing Blue Marble: Next Generation please credit \'NASA Earth Observatory.\'"',
    credit: 'NASA Earth Observatory'
  },
  'natural-earth': {
    name: 'Natural Earth cross-blended hypsometric tints with shaded relief, ocean bottom and drainages (10m, large size)',
    sourceUrl: 'https://naciscdn.org/naturalearth/10m/raster/HYP_LR_SR_OB_DR.zip',
    sourceFile: 'HYP_LR_SR_OB_DR.q95.jpg',
    conversion: {
      from: 'HYP_LR_SR_OB_DR.tif in HYP_LR_SR_OB_DR.zip (16200x8100 RGB)',
      zipSha256: '016924509def418d79e048f40434daed84d9848829813a54063333f8b68b9af9',
      tifSha256: '7bcc529c3f1148b05c4b6b78427fe3a68921c4e745068f5ab42d72c8087a230d',
      how: 'converted to JPEG quality 95 (4:4:4) with Pillow 12.1.1, once, on a developer machine; the JPEG is the source checked here'
    },
    page: 'https://www.naturalearthdata.com/downloads/10m-raster-data/10m-cross-blend-hypso/',
    terms: 'Natural Earth terms of use (https://www.naturalearthdata.com/about/terms-of-use/): "All versions of Natural Earth raster + vector map data found on this website are in the public domain." Crediting the authors is unnecessary.',
    credit: 'Made with Natural Earth'
  }
};

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

function fail(message) { console.error(message); process.exit(2); }

const source = arg('--source');
const expected = arg('--expect-sha256');
const set = arg('--set');
const maxZoom = Number(arg('--max-zoom'));
const quality = Number(arg('--quality', '75'));
const topQuality = Number(arg('--top-quality', String(quality)));
if (!source || !expected || !set) fail('Usage: --source <file.jpg> --expect-sha256 <hex> --set blue-marble|natural-earth --max-zoom N [--quality Q] [--top-quality Q]');
if (!SETS[set]) fail(`--set must be one of ${Object.keys(SETS).join(', ')}.`);
if (!Number.isInteger(maxZoom) || maxZoom < 0 || maxZoom > 6) fail('--max-zoom must be a whole number from 0 to 6.');
for (const q of [quality, topQuality]) if (!(q >= 1 && q <= 100)) fail('--quality and --top-quality must be from 1 to 100.');
if (!/^[0-9a-f]{64}$/.test(expected)) fail('--expect-sha256 takes 64 lowercase hex characters.');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = readFileSync(source);
const actual = sha256(sourceBytes);
if (actual !== expected) fail(`The source's SHA-256 is ${actual}, not the expected ${expected}. Refusing to build from a different file.`);

// ---- Decode (RGBA, libjpeg in WebAssembly) ----
const started = Date.now();
const decodeEntry = resolveDev('@jsquash/jpeg/decode.js');
const jpeg = await import(pathToFileURL(decodeEntry).href);
await jpeg.init(await WebAssembly.compile(readFileSync(path.join(path.dirname(decodeEntry), 'codec', 'dec', 'mozjpeg_dec.wasm'))));
const decoded = await jpeg.default(sourceBytes);
console.log(`Decoded ${decoded.width}x${decoded.height} in ${((Date.now() - started) / 1000).toFixed(1)} s.`);

// ---- Box-filtered copies, each half the size of the one before (rounded down), with integer arithmetic so every machine gets the same pixels ----
const levels = [{ width: decoded.width, height: decoded.height, data: decoded.data, channels: 4 }];
while (levels[levels.length - 1].width >= 2 * TILE) {
  const prev = levels[levels.length - 1];
  const width = Math.floor(prev.width / 2), height = Math.floor(prev.height / 2);
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const r0 = 2 * y * prev.width, r1 = (2 * y + 1) * prev.width;
    for (let x = 0; x < width; x += 1) {
      const ch = prev.channels;
      const a = (r0 + 2 * x) * ch, b = a + ch, c = (r1 + 2 * x) * ch, d = c + ch, o = (y * width + x) * 3;
      for (let k = 0; k < 3; k += 1) data[o + k] = (prev.data[a + k] + prev.data[b + k] + prev.data[c + k] + prev.data[d + k] + 2) >> 2;
    }
  }
  levels.push({ width, height, data, channels: 3 });
}

/** The smallest copy at least as wide as the zoom's world. */
function levelFor(worldWidth) {
  let best = levels[0];
  for (const level of levels) if (level.width >= worldWidth) best = level;
  return best;
}

// ---- Tiles ----
const encode = await webpEncoder();
const entries = [];
const written = new Set();
const totals = {};
for (let z = 0; z <= maxZoom; z += 1) {
  const n = 2 ** z;
  const world = n * TILE;
  const src = levelFor(world);
  const q = z === maxZoom ? topQuality : quality;
  // The source row and column of every output row and column: the same for every tile in a row or column of tiles.
  const sy = new Float64Array(world), sx = new Float64Array(world);
  for (let j = 0; j < world; j += 1) {
    const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, (Math.atan(Math.sinh(Math.PI * (1 - (2 * (j + 0.5)) / world))) * 180) / Math.PI));
    sy[j] = ((90 - lat) / 180) * src.height - 0.5;
  }
  for (let i = 0; i < world; i += 1) sx[i] = ((i + 0.5) / world) * src.width - 0.5;
  totals[z] = { tiles: 0, bytes: 0 };
  for (let x = 0; x < n; x += 1) {
    for (let y = 0; y < n; y += 1) {
      const rgba = new Uint8ClampedArray(TILE * TILE * 4);
      for (let j = 0; j < TILE; j += 1) {
        const fy = sy[y * TILE + j];
        const y0 = Math.floor(fy), ty = fy - y0;
        const ya = Math.min(src.height - 1, Math.max(0, y0)), yb = Math.min(src.height - 1, Math.max(0, y0 + 1));
        for (let i = 0; i < TILE; i += 1) {
          const fx = sx[x * TILE + i];
          const x0 = Math.floor(fx), tx = fx - x0;
          const xa = ((x0 % src.width) + src.width) % src.width, xb = (xa + 1) % src.width;
          const ch = src.channels;
          const p00 = (ya * src.width + xa) * ch, p10 = (ya * src.width + xb) * ch, p01 = (yb * src.width + xa) * ch, p11 = (yb * src.width + xb) * ch;
          const o = (j * TILE + i) * 4;
          for (let k = 0; k < 3; k += 1) {
            const top = src.data[p00 + k] * (1 - tx) + src.data[p10 + k] * tx;
            const bottom = src.data[p01 + k] * (1 - tx) + src.data[p11 + k] * tx;
            rgba[o + k] = Math.round(top * (1 - ty) + bottom * ty);
          }
          rgba[o + 3] = 255;
        }
      }
      const bytes = await encode({ data: rgba, width: TILE, height: TILE }, { quality: q, method: METHOD });
      const rel = `${z}/${x}/${y}.webp`;
      mkdirSync(path.join(OUT, set, String(z), String(x)), { recursive: true });
      writeFileSync(path.join(OUT, set, rel), bytes);
      written.add(rel);
      entries.push([`${z}/${x}/${y}`, bytes.length, sha256(bytes), sha256(rgba).slice(0, 16)]);
      totals[z].tiles += 1; totals[z].bytes += bytes.length;
    }
  }
  console.log(`z${z}: ${totals[z].tiles} tiles, ${totals[z].bytes.toLocaleString('en-US')} bytes (source copy ${src.width}x${src.height}, quality ${q}).`);
}

// Nothing in the set's folder that was not written now.
const strays = [];
const walk = (dir, rel) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const r = rel ? `${rel}/${entry.name}` : entry.name; if (entry.isDirectory()) walk(path.join(dir, entry.name), r); else if (!written.has(r)) strays.push(r); } };
walk(path.join(OUT, set), '');
if (strays.length) fail(`media/map/globe/${set}/ holds ${strays.length} file(s) this run did not write (for example ${strays[0]}). Remove the set's folder and run again.`);

// ---- Index: sets in a fixed order, one tile per line ----
entries.sort((a, b) => { const [za, xa, ya] = a[0].split('/').map(Number); const [zb, xb, yb] = b[0].split('/').map(Number); return za - zb || xa - xb || ya - yb; });
const indexFile = path.join(OUT, 'index.json');
const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : { format: 'near-map-tiles', version: 1, sets: {} };
index.sets[set] = { format: 'webp', minzoom: 0, maxzoom: maxZoom, bounds: [-180, -MAX_LAT, 180, MAX_LAT], tiles: entries };
const setText = (id) => {
  const s = index.sets[id];
  return `${JSON.stringify(id)}:{"format":${JSON.stringify(s.format)},"minzoom":${s.minzoom},"maxzoom":${s.maxzoom},"bounds":${JSON.stringify(s.bounds)},"tiles":[\n${s.tiles.map((t) => JSON.stringify(t)).join(',\n')}\n]}`;
};
const indexText = `{"format":"near-map-tiles","version":1,"sets":{${Object.keys(SETS).filter((id) => index.sets[id]).map(setText).join(',')}}}\n`;
writeFileSync(indexFile, indexText);

// ---- DATA.json ----
const dataFile = path.join(OUT, 'DATA.json');
const data = existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, 'utf8')) : {};
const pkg = (name) => JSON.parse(readFileSync(path.join(path.dirname(resolveDev(`${name}/package.json`)), 'package.json'), 'utf8'));
const record = {
  id: set, name: SETS[set].name, page: SETS[set].page, sourceUrl: SETS[set].sourceUrl, sourceFile: SETS[set].sourceFile, sourceSha256: actual,
  ...(SETS[set].conversion ? { conversion: SETS[set].conversion } : {}),
  terms: SETS[set].terms, credit: SETS[set].credit,
  generator: {
    script: 'scripts/build-globe-tiles.mjs', tileSize: TILE, minzoom: 0, maxzoom: maxZoom, quality, topQuality, method: METHOD,
    resampling: 'box-filtered halvings of the source, then bilinear at each pixel centre (Web Mercator, latitudes to +/-85.051129)',
    decoder: { name: '@jsquash/jpeg', version: pkg('@jsquash/jpeg').version, license: pkg('@jsquash/jpeg').license },
    encoder: { name: '@jsquash/webp', version: pkg('@jsquash/webp').version, license: pkg('@jsquash/webp').license }
  },
  tiles: entries.length, bytes: entries.reduce((sum, t) => sum + t[1], 0)
};
const sets = Object.keys(SETS).map((id) => (id === set ? record : (data.sets || []).find((entry) => entry.id === id))).filter(Boolean);
const out = {
  note: 'Third-party world imagery the COP map\'s globe draws, as 256 px Web Mercator WebP tiles made by scripts/build-globe-tiles.mjs from the source files below (checked by SHA-256) and never fetched at run time. index.json lists every tile with its bytes, SHA-256 and a digest of its pixels; a test checks the folder against it and indexSha256 here.',
  sets, indexSha256: sha256(Buffer.from(indexText, 'utf8'))
};
writeFileSync(dataFile, `${JSON.stringify(out, null, 2)}\n`);
console.log(`Wrote ${entries.length} tiles for ${set} (${record.bytes.toLocaleString('en-US')} bytes) in ${((Date.now() - started) / 1000).toFixed(1)} s; index ${out.indexSha256}.`);
