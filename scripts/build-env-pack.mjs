#!/usr/bin/env node
// Builds an environment pack from a real DEM and, optionally, a real forecast (WP-ENV), on a developer machine with GDAL installed. The output is the
// same format as the synthetic pack (docs/staff-env-packs.md), so the extension reads both the same way and never decodes GeoTIFF, DTED, GRIB2 or
// NetCDF itself.
//
// This script never runs in CI or in the extension: it refuses when CI is set, and it refuses when GDAL is not installed. It runs the GDAL tools
// directly (never through a shell), only on the files you name, and writes only into the output folder you name, which must not exist yet or be
// empty. It makes no network request of its own: give it local files.
//
//   npm run compile
//   node scripts/build-env-pack.mjs --out ./my-pack --id my-area --title "My training area" \
//     --dem ./elevation.tif --bounds -1.80,51.10,-1.60,51.25 --cell 0.0005 \
//     --attribution "Elevation: <provider>, <licence>" --source "<provider>|<licence>|<url>" --licence "<licence of the result>" \
//     [--forecast ./forecast.grib2 --model "<model name>" --weather-cell 0.05 --step-hours 3]
//
// A real-data pack must carry the attribution its sources require and every source's licence; the pack is checked with the extension's own validator
// before anything is written. Real-data packs are for real training areas, which need a frame over that area: until that is designed (v0.6.0), the
// COP map draws only packs that lie inside the scenario's exercise frame.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function refuse(message, code = 2) {
  console.error(message);
  process.exit(code);
}

if (process.env.CI || process.env.GITHUB_ACTIONS) refuse('build-env-pack runs only on a developer machine, never in CI.');

/** Runs a GDAL tool without a shell; returns its standard output. */
function gdal(tool, args) {
  return execFileSync(tool, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

let gdalVersion;
try { gdalVersion = gdal('gdalinfo', ['--version']).trim(); } catch {
  refuse('GDAL is not installed (gdalinfo was not found). Install GDAL on this machine to build a pack from real data; the synthetic pack needs no GDAL (scripts/generate-env-pack.mjs).');
}

const DIST = path.join(ROOT, 'dist', 'domain', 'staff', 'env', 'index.js');
if (!existsSync(DIST)) refuse('Run `npm run compile` first: this script uses the compiled pack format in dist/.');
const env = require(DIST);

// ---- Arguments ----------------------------------------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const one = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const many = (name) => args.flatMap((arg, i) => (arg === name && args[i + 1] !== undefined ? [args[i + 1]] : []));
const out = one('--out'), id = one('--id'), title = one('--title'), dem = one('--dem'), boundsText = one('--bounds'), licence = one('--licence');
const cell = Number(one('--cell') ?? '0.0005');
const forecast = one('--forecast'), model = one('--model'), weatherCell = Number(one('--weather-cell') ?? '0.05'), stepHours = Number(one('--step-hours') ?? '3');
const attribution = many('--attribution');
const sources = many('--source').map((text) => { const [name, sourceLicence, url] = text.split('|'); return { name, licence: sourceLicence, ...(url ? { url } : {}) }; });
if (!out || !id || !title || !dem || !boundsText || !licence) refuse('Needs --out, --id, --title, --dem, --bounds w,s,e,n and --licence. See the header of this script.');
if (!attribution.length || !sources.length) refuse('A real-data pack needs at least one --attribution line and one --source "name|licence|url".');
const bounds = boundsText.split(',').map(Number);
if (bounds.length !== 4 || !bounds.every(Number.isFinite) || !(bounds[0] < bounds[2]) || !(bounds[1] < bounds[3])) refuse('--bounds is west,south,east,north in degrees.');
if (!(cell > 0) || !(weatherCell > 0) || !(stepHours > 0)) refuse('--cell, --weather-cell and --step-hours must be positive.');
if (forecast && !model) refuse('--forecast needs --model (the forecast model\'s name, shown with the weather).');
for (const file of [dem, forecast].filter(Boolean)) if (!existsSync(file)) refuse(`${file} does not exist.`);
if (existsSync(out) && readdirSync(out).length) refuse(`${out} is not empty; give a new folder.`);

const work = mkdtempSync(path.join(tmpdir(), 'near-env-pack-'));
try {
  // ---- DEM: reproject to WGS 84, cut to the bounds on a square grid, write as an ASCII grid ----
  const demTif = path.join(work, 'dem.tif');
  const demAsc = path.join(work, 'dem.asc');
  gdal('gdalwarp', ['-q', '-t_srs', 'EPSG:4326', '-te', ...bounds.map(String), '-tr', String(cell), String(cell), '-r', 'bilinear', '-dstnodata', '-32768', '-of', 'GTiff', dem, demTif]);
  gdal('gdal_translate', ['-q', '-of', 'AAIGrid', '-ot', 'Float32', demTif, demAsc]);
  const demGrid = env.demFromAsciiGrid(env.parseAsciiGrid(readFileSync(demAsc, 'utf8')));

  // ---- Coastline: the 0 m contour of the same DEM ----
  const coastJson = path.join(work, 'coast.geojson');
  gdal('gdal_contour', ['-q', '-fl', '0', '-f', 'GeoJSON', demTif, coastJson]);
  const contour = JSON.parse(readFileSync(coastJson, 'utf8'));
  const coastline = {
    type: 'FeatureCollection',
    features: (contour.features ?? []).flatMap((feature) => {
      const g = feature.geometry;
      const lines = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
      return lines.filter((line) => line.length >= 2).map((line) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: line.map(([lon, lat]) => [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]) }, properties: { kind: 'coastline' } }));
    })
  };

  // ---- Forecast: GDAL decodes the GRIB2 or NetCDF bands; each wanted element at each valid time is warped to the same grid ----
  let weather;
  if (forecast) {
    const info = JSON.parse(gdal('gdalinfo', ['-json', forecast]));
    const bands = [];
    (info.bands ?? []).forEach((band, index) => {
      const meta = band.metadata?.[''] ?? {};
      if (!env.GRIB_ELEMENTS.includes(meta.GRIB_ELEMENT)) return;
      if (meta.GRIB_SHORT_NAME && !/^(0-SFC|10-HTGL|2-HTGL|0-MSL)/.test(meta.GRIB_SHORT_NAME)) return;
      const asc = path.join(work, `band-${index + 1}.asc`);
      const tif = path.join(work, `band-${index + 1}.tif`);
      gdal('gdalwarp', ['-q', '-b', String(index + 1), '-t_srs', 'EPSG:4326', '-te', ...bounds.map(String), '-tr', String(weatherCell), String(weatherCell), '-r', 'bilinear', '-of', 'GTiff', forecast, tif]);
      gdal('gdal_translate', ['-q', '-of', 'AAIGrid', '-ot', 'Float32', tif, asc]);
      bands.push({ element: meta.GRIB_ELEMENT, refTime: env.gribTime(meta.GRIB_REF_TIME), validTime: env.gribTime(meta.GRIB_VALID_TIME), grid: env.parseAsciiGrid(readFileSync(asc, 'utf8'), env.ENV_LIMITS.weatherCells) });
    });
    weather = env.weatherFromBands(model, bands, stepHours);
  }

  const files = env.writeEnvPack({ id, title, data: 'real', bounds: [bounds[0], bounds[1], bounds[2], bounds[3]], attribution, licence, sources, dem: demGrid, coastline, ...(weather ? { weather } : {}) });
  const check = env.readEnvPack(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text, 'utf8')])));
  if (!check.ok) refuse(`The built pack does not validate, so nothing was written:\n${check.problems.join('\n')}`, 1);
  mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(out, name), text);
  console.log(`Wrote a ${weather ? 'terrain and weather' : 'terrain'} pack to ${out} with ${gdalVersion}.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
