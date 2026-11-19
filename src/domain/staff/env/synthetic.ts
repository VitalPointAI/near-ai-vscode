// The synthetic environment pack for a scenario's exercise frame (research note 11, 6.5 and 9.2 item 4; WP-ENV): a DEM, a coastline and a weather
// forecast for the fictional region, made deterministically from a seed. Pure: no I/O, no clock, no vscode.
//
// Nothing here is real. The land is the scenario's hand-drawn outline (cop/geography.ts SYNTHETIC_OUTLINES), so the coastline the terrain shows is the
// one the rest of the map already draws. Heights rise inland from the coast, Harrow Ridge stands about 300 m above the valley floor along its line
// from KQ 4726 to KQ 4932 (the scenario's own description), the River Brenn cuts a valley, the Brenn marshes lie flat and low, and seeded hills and
// noise give the rest a natural look. The forecast follows the scenario's weather: a south-westerly most of the time, sea state 2 to 3, morning fog
// over the strait and the north coast, and one rain front crossing the peninsula with sea state 4 or more. The same seed always gives the same
// bytes; scripts/generate-env-pack.mjs writes them and a test makes them again and compares.
import { gridToWgs84 } from '../obs/frame';
import type { ExerciseFrame } from '../obs/frame';
import { SYNTHETIC_OUTLINES } from '../cop/geography';
import type { Scenario } from '../scenario';
import type { Bounds, Coastline, CoastlineFeature, Dem, WeatherFrameValues, WeatherGrid } from './pack';
import { writeEnvPack } from './pack';

/** Bumped when the generator's output changes for the same seed, so a pack says which generator made it. */
export const SYNTHETIC_GENERATOR_VERSION = 1;
export const SYNTHETIC_GENERATOR_SCRIPT = 'scripts/generate-env-pack.mjs';
/** The seed of the bundled IRON LANTERN pack. */
export const IRON_LANTERN_SEED = 20270524;

type Km = readonly [number, number];

/** A small, fast, seeded generator (mulberry32): the same seed gives the same sequence on every machine. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise on a lattice of `cell` km, from the seeded generator. */
function valueNoise(random: () => number, columns: number, rows: number, cell: number): (x: number, y: number) => number {
  const lattice: number[] = [];
  for (let i = 0; i < (columns + 2) * (rows + 2); i += 1) lattice.push(random() * 2 - 1);
  const at = (i: number, j: number) => lattice[Math.min(rows + 1, Math.max(0, j)) * (columns + 2) + Math.min(columns + 1, Math.max(0, i))];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const gx = x / cell, gy = y / cell;
    const i = Math.floor(gx), j = Math.floor(gy);
    const fx = smooth(gx - i), fy = smooth(gy - j);
    const top = at(i, j) * (1 - fx) + at(i + 1, j) * fx;
    const bottom = at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
}

function insideRing(point: Km, ring: readonly Km[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance(p: Km, a: Km, b: Km): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function pathDistance(p: Km, path: readonly Km[], skip?: (a: Km, b: Km) => boolean): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i += 1) if (!skip || !skip(path[i - 1], path[i])) best = Math.min(best, segmentDistance(p, path[i - 1], path[i]));
  return best;
}

/** Rounds a degree to 1e-6, towards the inside of a box, so a rounded corner never lies outside what it was cut from. */
const inward = (value: number, up: boolean) => (up ? Math.ceil(value * 1e6 - 1e-6) : Math.floor(value * 1e6 + 1e-6)) / 1e6;

function boxBounds(frame: ExerciseFrame, sw: Km, ne: Km): Bounds {
  const a = gridToWgs84(frame, { eastingMetres: sw[0] * 1000, northingMetres: sw[1] * 1000 });
  const b = gridToWgs84(frame, { eastingMetres: ne[0] * 1000, northingMetres: ne[1] * 1000 });
  return [inward(a.longitude, true), inward(a.latitude, true), inward(b.longitude, false), inward(b.latitude, false)];
}

function lonLat(frame: ExerciseFrame, km: Km): [number, number] {
  const point = gridToWgs84(frame, { eastingMetres: km[0] * 1000, northingMetres: km[1] * 1000 });
  return [Math.round(point.longitude * 1e6) / 1e6, Math.round(point.latitude * 1e6) / 1e6];
}

/** The terrain box of the IRON LANTERN pack in km east and north of the frame origin, and its spacing: the peninsula, the strait and the far shore. */
const DEM_BOX = { sw: [20, 0] as Km, ne: [78, 58] as Km, stepKm: 0.5 };
/** The forecast: every 10 km over the whole frame, every six hours over the inject script's window (D-6 0000 to D-3 0600, D-day 2027-05-24). */
const WEATHER = { stepKm: 10, runAt: '2027-05-17T18:00:00.000Z', firstValid: '2027-05-18T00:00:00.000Z', frames: 14, stepHours: 6 };

export interface SyntheticPackOptions { readonly seed: number }

/** The synthetic pack's files (manifest.json, dem.json, coastline.geojson, weather.json) as text. Undefined for a scenario with no frame or outline. */
export function syntheticEnvPack(scenario: Pick<Scenario, 'id' | 'title' | 'region'>, options: SyntheticPackOptions = { seed: IRON_LANTERN_SEED }): Record<string, string> | undefined {
  const frame = scenario.region.frame;
  const outline = SYNTHETIC_OUTLINES[scenario.id];
  if (!frame || !outline) return undefined;
  const random = seededRandom(options.seed);
  const side: Km = [frame.extent.eastings * frame.squareMetres / 1000, frame.extent.northings * frame.squareMetres / 1000];
  const onBoxEdge = (a: Km, b: Km) => (a[1] === 0 && b[1] === 0) || (a[0] === 0 && b[0] === 0) || (a[1] === side[1] && b[1] === side[1]) || (a[0] === side[0] && b[0] === side[0]);
  const coastDistance = (p: Km) => Math.min(...outline.land.map((ring) => pathDistance(p, ring, onBoxEdge)));
  const onLand = (p: Km) => outline.land.some((ring) => insideRing(p, ring));

  // ---- DEM ----
  const width = Math.round((DEM_BOX.ne[0] - DEM_BOX.sw[0]) / DEM_BOX.stepKm) + 1;
  const height = Math.round((DEM_BOX.ne[1] - DEM_BOX.sw[1]) / DEM_BOX.stepKm) + 1;
  const noise = valueNoise(random, Math.ceil(side[0] / 2), Math.ceil(side[1] / 2), 2);
  const hills = Array.from({ length: 6 }, () => ({ centre: [24 + random() * 48, 1 + random() * 7] as Km, radius: 2 + random() * 3, height: 70 + random() * 110 }));
  const ridges = outline.ridges.map((ridge) => ({ ...ridge, angle: (ridge.degrees * Math.PI) / 180, peak: 300 + random() * 30 }));
  const heights: number[] = [];
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const p: Km = [DEM_BOX.sw[0] + column * DEM_BOX.stepKm, DEM_BOX.ne[1] - row * DEM_BOX.stepKm];
      const d = coastDistance(p);
      if (!onLand(p)) { heights.push(-Math.round(3 + 60 * (1 - Math.exp(-d / 5)) + 4 * Math.abs(noise(p[0], p[1])))); continue; }
      if (outline.marsh.some((ring) => insideRing(p, ring))) { heights.push(2); continue; }
      let h = 3 + 55 * (1 - Math.exp(-d / 5));
      for (const ridge of ridges) {
        const dx = p[0] - ridge.centre[0], dy = p[1] - ridge.centre[1];
        const u = dx * Math.cos(ridge.angle) + dy * Math.sin(ridge.angle), v = -dx * Math.sin(ridge.angle) + dy * Math.cos(ridge.angle);
        h += ridge.peak * Math.exp(-((u * u) / (2 * (ridge.along * 0.85) ** 2) + (v * v) / (2 * (ridge.across * 0.7) ** 2)));
      }
      for (const hill of hills) h += hill.height * Math.exp(-((p[0] - hill.centre[0]) ** 2 + (p[1] - hill.centre[1]) ** 2) / (2 * hill.radius ** 2));
      for (const river of outline.rivers) { const dr = pathDistance(p, river.path); h *= 1 - 0.7 * Math.exp(-(dr * dr) / (2 * 0.6 ** 2)); }
      h += 10 * noise(p[0], p[1]) * Math.min(1, d);
      heights.push(Math.max(1, Math.round(h)));
    }
  }
  const dem: Dem = { format: 'near-env-dem', version: 1, bounds: boxBounds(frame, DEM_BOX.sw, DEM_BOX.ne), width, height, units: 'm', noData: -32768, heights };

  // ---- Coastline: the same land outline the map's synthetic geography draws ----
  const names = ['Kestrel Peninsula and the Aldmark mainland', 'Far shore of the Varn Strait', 'Gull Island'];
  const features: CoastlineFeature[] = outline.land.map((ring, index) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring.map((point) => lonLat(frame, point))] }, properties: { kind: 'land', ...(names[index] ? { name: names[index] } : {}) } }));
  const coastline: Coastline = { type: 'FeatureCollection', features };

  // ---- Weather ----
  const wWidth = Math.round(side[0] / WEATHER.stepKm) + 1;
  const wHeight = Math.round(side[1] / WEATHER.stepKm) + 1;
  const first = Date.parse(WEATHER.firstValid);
  const frontStart = first + 30 * 3_600_000; // the front reaches the west edge 30 hours into the window and crosses in about a day
  const frames: WeatherFrameValues[] = [];
  for (let n = 0; n < WEATHER.frames; n += 1) {
    const at = first + n * WEATHER.stepHours * 3_600_000;
    const localHour = (((new Date(at).getUTCHours() - 8) % 24) + 24) % 24;
    const frontX = ((at - frontStart) / 3_600_000) * 4.5;
    const speed: number[] = [], from: number[] = [], sea: number[] = [], visibility: number[] = [], rain: number[] = [];
    for (let row = 0; row < wHeight; row += 1) {
      for (let column = 0; column < wWidth; column += 1) {
        const p: Km = [column * WEATHER.stepKm, side[1] - row * WEATHER.stepKm];
        const inFront = Math.abs(p[0] - frontX) < 22;
        const jitter = random();
        const s = inFront ? 12 + 4 * jitter : 5 + 4 * jitter;
        speed.push(Math.round(s * 10) / 10);
        from.push(Math.round((inFront ? 205 : 240) + (random() - 0.5) * 30));
        const land = onLand(p);
        sea.push(land ? 0 : Math.min(9, Math.round(inFront ? 4 + random() * 1.4 : 2 + random() * 1.2)));
        const fogBank = localHour < 10 && p[1] >= 34 && p[1] <= 48 && p[0] >= 28 && p[0] <= 62;
        visibility.push(Math.round((fogBank ? 0.3 + random() * 0.5 : inFront ? 3 + random() * 3 : 12 + random() * 8) * 10) / 10);
        rain.push(Math.round((inFront ? 1 + random() * 5 : random() < 0.05 ? random() * 0.4 : 0) * 10) / 10);
      }
    }
    frames.push({ validAt: new Date(at).toISOString(), values: { 'wind-speed': speed, 'wind-from': from, 'sea-state': sea, visibility, precipitation: rain } });
  }
  const weather: WeatherGrid = {
    format: 'near-env-weather', version: 1, bounds: boxBounds(frame, [0, 0], side), width: wWidth, height: wHeight,
    model: { name: 'Synthetic exercise forecast', runAt: WEATHER.runAt }, stepHours: WEATHER.stepHours,
    variables: [{ id: 'wind-speed', units: 'm/s' }, { id: 'wind-from', units: 'degrees' }, { id: 'sea-state', units: 'douglas' }, { id: 'visibility', units: 'km' }, { id: 'precipitation', units: 'mm/h' }],
    frames
  };

  return writeEnvPack({
    id: `${scenario.id}-synthetic`, title: `${scenario.title}: synthetic terrain and weather`, data: 'synthetic', bounds: weather.bounds,
    frame: { scenario: scenario.id, grid: frame.grid },
    generator: { script: SYNTHETIC_GENERATOR_SCRIPT, seed: options.seed, version: SYNTHETIC_GENERATOR_VERSION },
    attribution: ['Synthetic exercise terrain and weather, generated from a seed. Nothing in this pack is a real place or a real forecast.'],
    licence: 'MIT, the same licence as this extension', dem, coastline, weather
  });
}
