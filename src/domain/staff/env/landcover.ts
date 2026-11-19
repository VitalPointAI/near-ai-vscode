// Synthetic land cover for a scenario's exercise frame (pack version 2, landcover.geojson): forest, scrub, farmland, beach, rock, built-up and marsh
// areas, and the roads and tracks between the places. Pure: no I/O, no clock, no vscode.
//
// One source of truth: the same file drives the photo-like imagery tiles (imagery.ts) and the topographic map's fills, so the two bases always agree.
// It is made from the pack's DEM and the scenario's hand-drawn outline, deterministically from the seed:
//   - built-up: an irregular area round each port and town, on land only
//   - marsh: the outline's marshes
//   - beach: low, gentle coast
//   - rock: Harrow Ridge's crest and the steepest ground
//   - forest: the ridge's flanks and seeded woods elsewhere, never on the shore
//   - farmland: low, gentle valley floor away from the coast (the imagery divides it into fields)
//   - scrub: coastal heath and the edges of the woods
//   - grass: everything else on land (not stored)
// Areas are classified on a 50 m grid, smoothed and traced into polygons (marching squares, then simplified), so the shapes are natural and small.
import { gridCentre, gridReferencesIn, gridToWgs84 } from '../obs/frame';
import type { ExerciseFrame } from '../obs/frame';
import { naturalLand, naturalRing, SYNTHETIC_OUTLINES } from '../cop/geography';
import type { Scenario } from '../scenario';
import { fbm, hash2 } from './noise';
import type { Bounds, Dem, PackResult } from './pack';
import { contourLevel } from './terrain';

export const LANDCOVER_FORMAT = 'near-env-landcover';
export const LANDCOVER_AREAS = ['forest', 'scrub', 'farmland', 'beach', 'rock', 'built-up', 'marsh'] as const;
export type LandcoverArea = (typeof LANDCOVER_AREAS)[number];
export const LANDCOVER_LINES = ['road', 'track'] as const;
export type LandcoverLine = (typeof LANDCOVER_LINES)[number];

export type Lonlat = readonly [number, number];
export interface LandcoverAreaFeature {
  readonly type: 'Feature';
  readonly geometry: { readonly type: 'Polygon'; readonly coordinates: readonly (readonly Lonlat[])[] };
  readonly properties: { readonly kind: LandcoverArea; readonly name?: string };
}
export interface LandcoverLineFeature {
  readonly type: 'Feature';
  readonly geometry: { readonly type: 'LineString'; readonly coordinates: readonly Lonlat[] };
  readonly properties: { readonly kind: LandcoverLine; readonly name?: string; readonly minor?: true };
}
export type LandcoverFeature = LandcoverAreaFeature | LandcoverLineFeature;
export interface Landcover { readonly type: 'FeatureCollection'; readonly features: readonly LandcoverFeature[] }

export const LANDCOVER_LIMITS = { features: 5000, points: 300_000 } as const;

type Km = readonly [number, number];

/** The box the land cover is classified in, in km east and north of the frame origin: the DEM's box, which holds all the land. */
export interface KmBox { readonly sw: Km; readonly ne: Km }

/** Km east and north of the frame origin to [longitude, latitude], rounded to 1e-5 degree (about a metre). */
export function kmToLonlat(frame: ExerciseFrame, p: Km, decimals = 5): [number, number] {
  const point = gridToWgs84(frame, { eastingMetres: p[0] * 1000, northingMetres: p[1] * 1000 });
  const f = 10 ** decimals;
  return [Math.round(point.longitude * f) / f, Math.round(point.latitude * f) / f];
}

/**
 * A DEM as a function of km east and north of the frame origin: bilinear by default (what the contours assume), or Catmull-Rom bicubic, whose slope
 * has no creases at the grid lines (for baked light). The nearest edge value outside the grid.
 */
export function demSampler(frame: ExerciseFrame, dem: Pick<Dem, 'bounds' | 'width' | 'height' | 'heights'>, cubic = false): (x: number, y: number) => number {
  const lat0 = frame.origin.latitude, lon0 = frame.origin.longitude;
  // Inverse of gridToWgs84 for the two corners: the frame's transform is linear in each axis.
  const sw = gridToWgs84(frame, { eastingMetres: 0, northingMetres: 0 });
  const one = gridToWgs84(frame, { eastingMetres: 1000, northingMetres: 1000 });
  const kmPerLon = 1 / (one.longitude - sw.longitude), kmPerLat = 1 / (one.latitude - sw.latitude);
  const west = (dem.bounds[0] - lon0) * kmPerLon, east = (dem.bounds[2] - lon0) * kmPerLon;
  const south = (dem.bounds[1] - lat0) * kmPerLat, north = (dem.bounds[3] - lat0) * kmPerLat;
  const w = dem.width, h = dem.height, H = dem.heights;
  const at = (i: number, j: number) => H[Math.max(0, Math.min(h - 1, j)) * w + Math.max(0, Math.min(w - 1, i))];
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  return (x, y) => {
    const gx = Math.max(0, Math.min(w - 1, ((x - west) / (east - west)) * (w - 1)));
    const gy = Math.max(0, Math.min(h - 1, ((north - y) / (north - south)) * (h - 1)));
    const i = Math.min(w - 2, Math.floor(gx)), j = Math.min(h - 2, Math.floor(gy));
    const fx = gx - i, fy = gy - j;
    if (cubic) {
      const row = (jj: number) => cr(at(i - 1, jj), at(i, jj), at(i + 1, jj), at(i + 2, jj), fx);
      return cr(row(j - 1), row(j), row(j + 1), row(j + 2), fy);
    }
    const a = H[j * w + i], b = H[j * w + i + 1], c = H[(j + 1) * w + i], d = H[(j + 1) * w + i + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

export function insideRing(p: Km, ring: readonly Km[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Fills polygons (with holes, even-odd) into a raster by scanlines. */
export function fillPolygon(raster: Uint8Array, width: number, height: number, toGrid: (lon: number, lat: number) => [number, number], rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, value: number): void {
  const gridRings = rings.map((ring) => ring.map(([lon, lat]) => toGrid(lon, lat)));
  let minY = Infinity, maxY = -Infinity;
  for (const ring of gridRings) for (const [, y] of ring) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const y0 = Math.max(0, Math.ceil(minY - 0.5)), y1 = Math.min(height - 1, Math.floor(maxY - 0.5));
  const xs: number[] = [];
  for (let j = y0; j <= y1; j += 1) {
    const cy = j + 0.5;
    xs.length = 0;
    for (const ring of gridRings) for (let i = 0, k = ring.length - 1; i < ring.length; k = i, i += 1) {
      const [xi, yi] = ring[i], [xk, yk] = ring[k];
      if ((yi > cy) !== (yk > cy)) xs.push(xi + ((cy - yi) / (yk - yi)) * (xk - xi));
    }
    xs.sort((a, b) => a - b);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      const a = Math.max(0, Math.ceil(xs[n] - 0.5)), b = Math.min(width - 1, Math.floor(xs[n + 1] - 0.5));
      if (b >= a) raster.fill(value, j * width + a, j * width + b + 1);
    }
  }
}

/** Douglas-Peucker in km. */
function simplify(points: Km[], tolerance: number): Km[] {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, at = -1;
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i += 1) {
      const d = Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tolerance && at > 0) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Douglas-Peucker for a closed ring (first point repeated last): split at the point farthest from the start, so neither half is degenerate. */
function simplifyRing(ring: Km[], tolerance: number): Km[] {
  let far = 0, best = -1;
  ring.forEach((p, i) => { const d = Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]); if (d > best) { best = d; far = i; } });
  if (far === 0) return ring;
  return [...simplify(ring.slice(0, far + 1), tolerance), ...simplify(ring.slice(far), tolerance).slice(1)];
}

function ringArea(ring: readonly Km[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return sum / 2;
}

/** Chaikin corner cutting, keeping the ends. */
function smoothLine(points: Km[], rounds = 2): Km[] {
  let out = points;
  for (let r = 0; r < rounds; r += 1) {
    const next: Km[] = [out[0]];
    for (let i = 0; i < out.length - 1; i += 1) {
      const [ax, ay] = out[i], [bx, by] = out[i + 1];
      next.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/** The land cover of a scenario's frame, or undefined for a scenario with no frame or outline. `box` is the DEM's box in km. */
export function syntheticLandcover(scenario: Pick<Scenario, 'id' | 'region'>, dem: Dem, box: KmBox, seed: number): Landcover | undefined {
  const frame = scenario.region.frame;
  const outline = SYNTHETIC_OUTLINES[scenario.id];
  if (!frame || !outline) return undefined;
  const height = demSampler(frame, dem);
  const step = 0.05;
  const W = Math.round((box.ne[0] - box.sw[0]) / step) + 1, H = Math.round((box.ne[1] - box.sw[1]) / step) + 1;
  const at = (i: number, j: number): Km => [box.sw[0] + i * step, box.ne[1] - j * step];
  const side: Km = [frame.extent.eastings * frame.squareMetres / 1000, frame.extent.northings * frame.squareMetres / 1000];
  const naturalRings = naturalLand(outline, side);
  const marshRings = outline.marsh.map((ring, index) => naturalRing(ring, 100 + index, side));
  const marsh = new Uint8Array(W * H);
  for (const ring of marshRings) fillPolygon(marsh, W, H, (x, y) => [(x - box.sw[0]) / step + 0.5, (box.ne[1] - y) / step + 0.5], [ring], 1);
  // Cell (i, j) is the point at(i, j); the fill tests cell centres, so the grid is offset by half a cell.
  const land = new Uint8Array(W * H);
  for (const ring of naturalRings) fillPolygon(land, W, H, (x, y) => [(x - box.sw[0]) / step + 0.5, (box.ne[1] - y) / step + 0.5], [ring], 1);
  const h = new Float32Array(W * H);
  for (let j = 0; j < H; j += 1) for (let i = 0; i < W; i += 1) { const p = at(i, j); h[j * W + i] = height(p[0], p[1]); }
  // Distance to the coast in km for land cells (two-pass chamfer).
  const dist = new Float32Array(W * H);
  for (let k = 0; k < W * H; k += 1) dist[k] = land[k] ? 1e9 : 0;
  const d1 = step, d2 = step * Math.SQRT2;
  for (let j = 0; j < H; j += 1) for (let i = 0; i < W; i += 1) {
    const k = j * W + i; let v = dist[k];
    if (i > 0) v = Math.min(v, dist[k - 1] + d1);
    if (j > 0) { v = Math.min(v, dist[k - W] + d1); if (i > 0) v = Math.min(v, dist[k - W - 1] + d2); if (i < W - 1) v = Math.min(v, dist[k - W + 1] + d2); }
    dist[k] = v;
  }
  for (let j = H - 1; j >= 0; j -= 1) for (let i = W - 1; i >= 0; i -= 1) {
    const k = j * W + i; let v = dist[k];
    if (i < W - 1) v = Math.min(v, dist[k + 1] + d1);
    if (j < H - 1) { v = Math.min(v, dist[k + W] + d1); if (i < W - 1) v = Math.min(v, dist[k + W + 1] + d2); if (i > 0) v = Math.min(v, dist[k + W - 1] + d2); }
    dist[k] = v;
  }
  const slopeAt = (i: number, j: number) => {
    const k = j * W + i;
    const dx = (h[k + (i < W - 1 ? 1 : 0)] - h[k - (i > 0 ? 1 : 0)]) / (step * 1000 * ((i < W - 1 ? 1 : 0) + (i > 0 ? 1 : 0)));
    const dy = (h[k + (j < H - 1 ? W : 0)] - h[k - (j > 0 ? W : 0)]) / (step * 1000 * ((j < H - 1 ? 1 : 0) + (j > 0 ? 1 : 0)));
    return Math.hypot(dx, dy);
  };

  // The places that get a built-up area: ports and towns at their grid references.
  const towns: Array<{ name: string; centre: Km; radius: number }> = [];
  for (const feature of scenario.region.features) {
    if (feature.kind !== 'port' && feature.kind !== 'town') continue;
    const reference = gridReferencesIn(feature.location, frame.grid, frame.squareMetres)[0];
    if (!reference) continue;
    const c = gridCentre(reference);
    towns.push({ name: feature.name, centre: [c.eastingMetres / 1000, c.northingMetres / 1000], radius: feature.kind === 'port' ? 1.7 : 0.75 + 0.35 * hash2(towns.length, 7, seed) });
  }
  const beachNamed = scenario.region.features.filter((feature) => feature.kind === 'beach').flatMap((feature) => gridReferencesIn(feature.location, frame.grid, frame.squareMetres).map((r) => [r.eastingMetres / 1000, r.northingMetres / 1000] as Km));

  const CLASS: Record<LandcoverArea, number> = { forest: 1, scrub: 2, farmland: 3, beach: 4, rock: 5, 'built-up': 6, marsh: 7 };
  const cls = new Uint8Array(W * H);
  for (let j = 0; j < H; j += 1) for (let i = 0; i < W; i += 1) {
    const k = j * W + i;
    if (!land[k]) continue;
    const p = at(i, j);
    const [x, y] = p;
    const z = h[k], d = dist[k], s = slopeAt(i, j);
    if (marsh[k]) { cls[k] = CLASS.marsh; continue; }
    const town = towns.find((t) => Math.hypot(x - t.centre[0], y - t.centre[1]) + 0.35 * t.radius * fbm(x / 0.5, y / 0.5, seed + 11) < t.radius);
    if (town) { cls[k] = CLASS['built-up']; continue; }
    const nearNamedBeach = beachNamed.some((b) => x >= b[0] - 0.4 && x <= b[0] + 1.4 && Math.abs(y - b[1] - 0.5) < 1.5);
    if (d < (nearNamedBeach ? 0.16 : 0.09) && z < 12 && s < 0.08 && (nearNamedBeach || fbm(x / 0.8, y / 0.8, seed + 21) > -0.15)) { cls[k] = CLASS.beach; continue; }
    if ((z > 268 + 30 * fbm(x / 0.4, y / 0.4, seed + 31) && fbm(x / 0.6, y / 0.6, seed + 33) > -0.2) || s > 0.2 + 0.05 * fbm(x / 0.3, y / 0.3, seed + 32)) { cls[k] = CLASS.rock; continue; }
    const woods = fbm(x / 2.2, y / 2.2, seed + 41, 4);
    const flank = z > 75 && z < 245;
    if (d > 0.35 && ((flank && woods > -0.1) || woods > 0.32)) { cls[k] = CLASS.forest; continue; }
    if (z > 240) { cls[k] = CLASS.scrub; continue; }
    if (d > 0.3 && z < 95 && s < 0.05 && fbm(x / 3, y / 3, seed + 51, 3) > -0.25) { cls[k] = CLASS.farmland; continue; }
    if ((d < 1.4 && fbm(x / 0.9, y / 0.9, seed + 61) > 0.1) || (woods > 0.18 && woods <= 0.32)) cls[k] = CLASS.scrub;
  }

  // ---- Trace each class into polygons ----
  const features: LandcoverFeature[] = [];
  const toLonlat = (p: Km) => kmToLonlat(frame, p);
  for (const kind of LANDCOVER_AREAS) {
    const c = CLASS[kind];
    // Padded by one cell of nothing, so every traced line is a closed ring; smoothed once, so the outlines are not stair-stepped.
    const PW = W + 2, PH = H + 2;
    const raw = new Float32Array(PW * PH);
    for (let j = 0; j < H; j += 1) for (let i = 0; i < W; i += 1) if (cls[j * W + i] === c) raw[(j + 1) * PW + i + 1] = 1;
    const smooth = new Float32Array(PW * PH);
    for (let j = 1; j < PH - 1; j += 1) for (let i = 1; i < PW - 1; i += 1) {
      let s = 0;
      for (let b = -1; b <= 1; b += 1) for (let a = -1; a <= 1; a += 1) s += raw[(j + b) * PW + i + a];
      smooth[j * PW + i] = s / 9;
    }
    const lines = contourLevel({ width: PW, height: PH, at: (x, y) => smooth[y * PW + x] }, 0.5);
    const rings = lines.filter((line) => line.closed).map((line) => simplifyRing(line.points.map(([gx, gy]): Km => [box.sw[0] + (gx - 1) * step, box.ne[1] - (gy - 1) * step]), kind === 'beach' ? 0.012 : 0.025))
      .filter((ring) => ring.length >= 4 && Math.abs(ringArea(ring)) >= (kind === 'beach' ? 0.004 : 0.03));
    // Outer rings and holes by how many other rings hold them: even depth is an outer ring, odd a hole of the smallest ring round it.
    const depth = rings.map((ring, index) => rings.filter((other, o) => o !== index && Math.abs(ringArea(other)) > Math.abs(ringArea(ring)) && insideRing(ring[0], other)).length);
    const outers = rings.map((ring, index) => ({ ring, index })).filter((entry) => depth[entry.index] % 2 === 0);
    for (const outer of outers) {
      const holes = rings.filter((ring, index) => depth[index] === depth[outer.index] + 1 && insideRing(ring[0], outer.ring));
      const name = kind === 'built-up' ? towns.find((t) => insideRing(t.centre, outer.ring))?.name : undefined;
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [outer.ring, ...holes].map((ring) => ring.map(toLonlat)) }, properties: { kind, ...(name ? { name } : {}) } });
    }
  }

  // ---- Roads and tracks ----
  const onLand = (p: Km) => naturalRings.some((ring) => insideRing(p, ring));
  let lineSeed = seed + 1000;
  /** A gently winding line through the waypoints: seeded midpoint displacement across each leg, kept on land, then smoothed. */
  const wind = (points: readonly Km[], amount: number): Km[] => {
    let out: Km[] = [...points];
    for (let round = 0, a = amount; round < 5; round += 1, a *= 0.5) {
      const next: Km[] = [out[0]];
      for (let i = 0; i < out.length - 1; i += 1) {
        const [ax, ay] = out[i], [bx, by] = out[i + 1];
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const off = (hash2(i, round, lineSeed) * 2 - 1) * a * len;
        const mid: Km = [(ax + bx) / 2 - ((by - ay) / len) * off, (ay + by) / 2 + ((bx - ax) / len) * off];
        next.push(onLand(mid) ? mid : [(ax + bx) / 2, (ay + by) / 2], out[i + 1]);
      }
      out = next;
    }
    lineSeed += 17;
    return smoothLine(out, 2);
  };
  const placeKm = (name: string): Km | undefined => {
    const feature = scenario.region.features.find((f) => f.name === name);
    const reference = feature ? gridReferencesIn(feature.location, frame.grid, frame.squareMetres)[0] : undefined;
    if (!reference) return undefined;
    const c = gridCentre(reference);
    return [c.eastingMetres / 1000, c.northingMetres / 1000];
  };
  const lineFeature = (kind: LandcoverLine, points: Km[], extra: { name?: string; minor?: true } = {}): LandcoverLineFeature => ({
    type: 'Feature', geometry: { type: 'LineString', coordinates: simplify(points, 0.004).map(toLonlat) }, properties: { kind, ...extra }
  });
  const roads: Km[][] = [];
  for (const feature of scenario.region.features) {
    if (feature.kind !== 'route') continue;
    const points = gridReferencesIn(feature.location, frame.grid, frame.squareMetres).map((r) => { const c = gridCentre(r); return [c.eastingMetres / 1000, c.northingMetres / 1000] as Km; });
    if (points.length < 2) continue;
    const road = wind(points, 0.08);
    roads.push(road);
    features.push(lineFeature('road', road, { name: feature.name }));
  }
  const calder = placeKm('Port Calder'), kell = placeKm('Kell'), saltmere = placeKm('Saltmere');
  if (calder && kell) { const r = wind([calder, [(calder[0] + kell[0]) / 2 + 0.6, (calder[1] + kell[1]) / 2 + 0.3], kell], 0.06); roads.push(r); features.push(lineFeature('road', r, { minor: true })); }
  if (saltmere) { const r = wind([saltmere, [saltmere[0] + 3.5, saltmere[1] + 1.2], [saltmere[0] + 6.8, saltmere[1] + 0.6]], 0.1); roads.push(r); features.push(lineFeature('road', r, { minor: true })); }
  for (const ridge of outline.ridges) {
    const a = (ridge.degrees * Math.PI) / 180, half = ridge.along * 0.9;
    const ends: Km[] = [[ridge.centre[0] - Math.cos(a) * half, ridge.centre[1] - Math.sin(a) * half], ridge.centre, [ridge.centre[0] + Math.cos(a) * half, ridge.centre[1] + Math.sin(a) * half]];
    features.push(lineFeature('track', wind(ends, 0.05), { name: 'Harrow Ridge crest track' }));
  }
  // Farm tracks: from points along the roads out across the fields, wandering a little, ending before the coast.
  const rnd = (n: number) => hash2(n, 99, seed + 77);
  for (let t = 0; t < 9 && roads.length; t += 1) {
    const road = roads[Math.floor(rnd(t * 3) * roads.length)];
    const from = road[Math.floor((0.15 + 0.7 * rnd(t * 3 + 1)) * (road.length - 1))];
    let angle = rnd(t * 3 + 2) * Math.PI * 2;
    const path: Km[] = [from];
    let p = from;
    const steps = 6 + Math.floor(rnd(t * 5 + 3) * 10);
    for (let s = 0; s < steps; s += 1) {
      angle += (hash2(t, s, seed + 88) - 0.5) * 0.7;
      const next: Km = [p[0] + Math.cos(angle) * 0.2, p[1] + Math.sin(angle) * 0.2];
      const k = Math.round((box.ne[1] - next[1]) / step) * W + Math.round((next[0] - box.sw[0]) / step);
      if (!onLand(next) || dist[k] < 0.25 || cls[k] === CLASS['built-up'] || cls[k] === CLASS.marsh) break;
      path.push(next); p = next;
    }
    if (path.length >= 4) features.push(lineFeature('track', smoothLine(path, 2)));
  }
  return { type: 'FeatureCollection', features };
}

/** The land cover as committed: one feature per line, keys in a fixed order. */
export function writeLandcover(landcover: Landcover): string {
  return `{"type":"FeatureCollection","features":[\n${landcover.features.map((feature) => JSON.stringify({ type: 'Feature', properties: feature.properties, geometry: feature.geometry })).join(',\n')}\n]}\n`;
}

/** Checks a land cover file's shape and that every coordinate lies inside `bounds`. */
export function checkLandcover(value: unknown, bounds: Bounds): PackResult<Landcover> {
  const problems: string[] = [];
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) return { ok: false, problems: ['landcover: must be a GeoJSON FeatureCollection.'] };
  if (value.features.length > LANDCOVER_LIMITS.features) return { ok: false, problems: [`landcover: at most ${LANDCOVER_LIMITS.features} features.`] };
  let points = 0, strays = 0;
  const position = (c: unknown): boolean => {
    if (!(Array.isArray(c) && c.length === 2 && typeof c[0] === 'number' && typeof c[1] === 'number' && Number.isFinite(c[0]) && Number.isFinite(c[1]))) return false;
    points += 1;
    if (c[0] < bounds[0] - 1e-6 || c[0] > bounds[2] + 1e-6 || c[1] < bounds[1] - 1e-6 || c[1] > bounds[3] + 1e-6) strays += 1;
    return true;
  };
  value.features.forEach((feature, index) => {
    const where = `landcover features[${index}]`;
    if (!isObject(feature) || feature.type !== 'Feature' || !isObject(feature.geometry) || !isObject(feature.properties)) { problems.push(`${where}: not a GeoJSON feature.`); return; }
    const kind = feature.properties.kind, g = feature.geometry;
    if ((LANDCOVER_AREAS as readonly unknown[]).includes(kind) && g.type === 'Polygon') {
      if (!Array.isArray(g.coordinates) || !g.coordinates.length || !g.coordinates.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(position))) problems.push(`${where}: an area needs closed rings of [longitude, latitude].`);
    } else if ((LANDCOVER_LINES as readonly unknown[]).includes(kind) && g.type === 'LineString') {
      if (!Array.isArray(g.coordinates) || g.coordinates.length < 2 || !g.coordinates.every(position)) problems.push(`${where}: a line needs at least two [longitude, latitude] points.`);
    } else problems.push(`${where}: kind must be an area (${LANDCOVER_AREAS.join(', ')}) as a Polygon or a line (road, track) as a LineString.`);
    for (const key of Object.keys(feature.properties)) if (!['kind', 'name', 'minor'].includes(key)) problems.push(`${where}: unknown property "${key.slice(0, 40)}".`);
    const name = feature.properties.name;
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f]/.test(name))) problems.push(`${where}: name must be short text.`);
    if (feature.properties.minor !== undefined && feature.properties.minor !== true) problems.push(`${where}: minor is true or absent.`);
  });
  if (points > LANDCOVER_LIMITS.points) problems.push(`landcover: at most ${LANDCOVER_LIMITS.points.toLocaleString('en-US')} points.`);
  if (strays) problems.push(`landcover: ${strays} coordinate${strays === 1 ? '' : 's'} lie outside the pack's bounding box.`);
  return problems.length ? { ok: false, problems: problems.slice(0, 10) } : { ok: true, value: value as unknown as Landcover };
}
