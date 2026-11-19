// Contours and hillshade from a pack's DEM (research note 11, 6.4; WP-ENV). Pure: no I/O, no clock, no vscode.
//
// Both are computed on the host from the grid and sent to the map as plain GeoJSON, so the page draws them with the same two renderers it already
// has (MapLibre and SVG) and asks for nothing: no terrain tiles, no raster image, no worker of its own.
//
// Contours: marching squares on the grid's points, one pass per level. Each crossing lies on a grid edge, interpolated linearly between the edge's two
// heights; a saddle (two opposite corners above the level) is split by the average of the cell's four corners, so the result never depends on the
// order cells are visited. Segments meeting at the same edge are joined into lines; a line that comes back to its start is a closed ring.
//
// Hillshade: the usual shaded-relief formula (Horn's slope and aspect, light from the north-west at 45 degrees), drawn as two tones over flat ground:
// a shadow on slopes away from the light and a light tone on slopes towards it, each in a few steps of opacity. Cells of the same tone and step next
// to each other in a row are merged into one rectangle, so a ridge is a few hundred shapes, not thousands.
import { EARTH_RADIUS_M } from '../obs/frame';
import type { Bounds, Dem } from './pack';

export type Position = readonly [number, number];

/** A contour line in grid units: x from 0 (west) to width - 1 (east), y from 0 (north) to height - 1 (south). */
export interface GridLine { readonly level: number; readonly points: readonly Position[]; readonly closed: boolean }

/** The heights a grid has at (x, y), as a function, so the contour code reads no array directly. */
export interface Grid { readonly width: number; readonly height: number; readonly at: (x: number, y: number) => number }

export function demGrid(dem: Pick<Dem, 'width' | 'height' | 'heights' | 'noData'>, fill = -1): Grid {
  return { width: dem.width, height: dem.height, at: (x, y) => { const h = dem.heights[y * dem.width + x]; return h === dem.noData ? fill : h; } };
}

/**
 * The contour lines of one level. A point exactly at the level counts as above it, so a line never passes through a grid point and every crossing is
 * strictly inside its edge or at its upper end.
 */
export function contourLevel(grid: Grid, level: number): GridLine[] {
  const above = (x: number, y: number) => grid.at(x, y) >= level;
  // An edge is named by its lower-left point and its direction: h (to x + 1) or v (to y + 1).
  const crossing = (key: string): Position => {
    const [kind, xs, ys] = key.split(':');
    const x = Number(xs); const y = Number(ys);
    const a = grid.at(x, y);
    const b = kind === 'h' ? grid.at(x + 1, y) : grid.at(x, y + 1);
    const t = a === b ? 0.5 : Math.min(1, Math.max(0, (level - a) / (b - a)));
    return kind === 'h' ? [x + t, y] : [x, y + t];
  };
  const segments: Array<[string, string]> = [];
  for (let y = 0; y < grid.height - 1; y += 1) {
    for (let x = 0; x < grid.width - 1; x += 1) {
      // Corners: top-left (x, y), top-right (x + 1, y), bottom-right (x + 1, y + 1), bottom-left (x, y + 1). Edges: top, right, bottom, left.
      const tl = above(x, y), tr = above(x + 1, y), br = above(x + 1, y + 1), bl = above(x, y + 1);
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const top = `h:${x}:${y}`, bottom = `h:${x}:${y + 1}`, left = `v:${x}:${y}`, right = `v:${x + 1}:${y}`;
      const centreAbove = (grid.at(x, y) + grid.at(x + 1, y) + grid.at(x + 1, y + 1) + grid.at(x, y + 1)) / 4 >= level;
      switch (code) {
        case 1: case 14: segments.push([left, bottom]); break;
        case 2: case 13: segments.push([bottom, right]); break;
        case 3: case 12: segments.push([left, right]); break;
        case 4: case 11: segments.push([top, right]); break;
        case 6: case 9: segments.push([top, bottom]); break;
        case 7: case 8: segments.push([left, top]); break;
        case 5: // tr and bl above
          if (centreAbove) { segments.push([left, top]); segments.push([bottom, right]); } else { segments.push([top, right]); segments.push([left, bottom]); }
          break;
        case 10: // tl and br above
          if (centreAbove) { segments.push([top, right]); segments.push([left, bottom]); } else { segments.push([left, top]); segments.push([bottom, right]); }
          break;
      }
    }
  }
  // Join: every interior edge is shared by at most two segments.
  const byEdge = new Map<string, number[]>();
  segments.forEach(([a, b], index) => {
    for (const key of [a, b]) { const list = byEdge.get(key); if (list) list.push(index); else byEdge.set(key, [index]); }
  });
  const used = new Array<boolean>(segments.length).fill(false);
  const walk = (start: number, from: string): string[] => {
    const keys: string[] = [];
    let current = start;
    let entry = from;
    for (;;) {
      used[current] = true;
      const [a, b] = segments[current];
      const exit = a === entry ? b : a;
      keys.push(exit);
      const next = (byEdge.get(exit) ?? []).find((index) => !used[index]);
      if (next === undefined) return keys;
      current = next;
      entry = exit;
    }
  };
  const lines: GridLine[] = [];
  // Open lines first, from an end that only one segment touches (a line that leaves the grid), then the closed rings.
  const order = segments.map((_, index) => index).sort((i, j) => {
    const ends = (n: number) => segments[n].some((key) => (byEdge.get(key) ?? []).length === 1) ? 0 : 1;
    return ends(i) - ends(j) || i - j;
  });
  for (const start of order) {
    if (used[start]) continue;
    const [a, b] = segments[start];
    const open = (byEdge.get(a) ?? []).length === 1 ? a : (byEdge.get(b) ?? []).length === 1 ? b : a;
    const keys = [open, ...walk(start, open)];
    const closed = keys.length > 2 && keys[keys.length - 1] === keys[0];
    lines.push({ level, points: keys.map(crossing), closed });
  }
  return lines;
}

/** Contour levels every `interval` metres from the first above 0 to the highest point. */
export function contourLevels(grid: Grid, interval: number, max = 50): number[] {
  let top = -Infinity;
  for (let y = 0; y < grid.height; y += 1) for (let x = 0; x < grid.width; x += 1) top = Math.max(top, grid.at(x, y));
  const out: number[] = [];
  for (let level = interval; level <= top && out.length < max; level += interval) out.push(level);
  return out;
}

/** Grid units to [longitude, latitude] in the grid's bounds, rounded to a millimetre-scale 1e-6 degree. */
export function gridToLonLat(bounds: Bounds, width: number, height: number, point: Position): [number, number] {
  const lon = bounds[0] + (point[0] / (width - 1)) * (bounds[2] - bounds[0]);
  const lat = bounds[3] - (point[1] / (height - 1)) * (bounds[3] - bounds[1]);
  return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}

export interface ContourFeature {
  readonly type: 'Feature';
  readonly geometry: { readonly type: 'LineString'; readonly coordinates: readonly Position[] };
  readonly properties: { readonly kind: 'contour'; readonly height: number; readonly index: boolean };
}

/** The DEM's contour lines as GeoJSON, every `interval` metres, with every `indexEvery`-th line an index contour (drawn heavier). */
export function demContours(dem: Dem, interval = 50, indexEvery = 5): ContourFeature[] {
  const grid = demGrid(dem);
  const out: ContourFeature[] = [];
  for (const level of contourLevels(grid, interval)) {
    for (const line of contourLevel(grid, level)) {
      if (line.points.length < 2) continue;
      out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line.points.map((point) => gridToLonLat(dem.bounds, dem.width, dem.height, point)) }, properties: { kind: 'contour', height: level, index: (level / interval) % indexEvery === 0 } });
    }
  }
  return out;
}

// ---- Hillshade -------------------------------------------------------------------------------------------------------------------------------

/** The illumination of each point, 0 (dark) to 1 (fully lit), by Horn's method; 0 for sea points (height 0 or below), which are not shaded. */
export function hillshade(dem: Dem, options: { readonly azimuth?: number; readonly altitude?: number; readonly zFactor?: number } = {}): number[] {
  const { width, height } = dem;
  const grid = demGrid(dem, 0);
  const midLat = ((dem.bounds[1] + dem.bounds[3]) / 2) * (Math.PI / 180);
  const dx = ((dem.bounds[2] - dem.bounds[0]) / (width - 1)) * (Math.PI / 180) * EARTH_RADIUS_M * Math.cos(midLat);
  const dy = ((dem.bounds[3] - dem.bounds[1]) / (height - 1)) * (Math.PI / 180) * EARTH_RADIUS_M;
  const zenith = ((90 - (options.altitude ?? 45)) * Math.PI) / 180;
  const azimuth = ((360 - (options.azimuth ?? 315) + 90) % 360) * (Math.PI / 180);
  const z = options.zFactor ?? 1;
  const at = (x: number, y: number) => grid.at(Math.min(width - 1, Math.max(0, x)), Math.min(height - 1, Math.max(0, y)));
  const out = new Array<number>(width * height).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (grid.at(x, y) <= 0) continue;
      const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1), d = at(x - 1, y), f = at(x + 1, y), g = at(x - 1, y + 1), h = at(x, y + 1), i = at(x + 1, y + 1);
      const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx);
      const dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * dy);
      const slope = Math.atan(z * Math.sqrt(dzdx * dzdx + dzdy * dzdy));
      let aspect = Math.atan2(dzdy, -dzdx);
      if (aspect < 0) aspect += 2 * Math.PI;
      const value = Math.cos(zenith) * Math.cos(slope) + Math.sin(zenith) * Math.sin(slope) * Math.cos(azimuth - aspect);
      out[y * width + x] = Math.max(0, Math.min(1, value));
    }
  }
  return out;
}

export interface HillshadeFeature {
  readonly type: 'Feature';
  readonly geometry: { readonly type: 'Polygon'; readonly coordinates: readonly (readonly Position[])[] };
  readonly properties: { readonly kind: 'hillshade'; readonly tone: 'shadow' | 'light'; readonly opacity: number };
}

/** The hillshade as merged rectangles of a few tones and steps over the flat-ground value; flat land and sea draw nothing. */
export function hillshadeFeatures(dem: Dem, options: { readonly steps?: number; readonly zFactor?: number } = {}): HillshadeFeature[] {
  const steps = options.steps ?? 4;
  const shade = hillshade(dem, { zFactor: options.zFactor ?? 3 });
  const flat = Math.cos(Math.PI / 4);
  const { width, height } = dem;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  const out: HillshadeFeature[] = [];
  for (let y = 0; y < height; y += 1) {
    let x = 0;
    while (x < width) {
      const key = (i: number): string | undefined => {
        if (dem.heights[y * width + i] <= 0 || dem.heights[y * width + i] === dem.noData) return undefined;
        const v = shade[y * width + i];
        const delta = v - flat;
        const step = Math.min(steps, Math.floor((Math.abs(delta) / (delta < 0 ? flat : 1 - flat)) * steps * 1.5));
        return step === 0 ? undefined : `${delta < 0 ? 'shadow' : 'light'}:${step}`;
      };
      const k = key(x);
      if (!k) { x += 1; continue; }
      let end = x;
      while (end + 1 < width && key(end + 1) === k) end += 1;
      const [tone, step] = k.split(':');
      const p = (i: number, j: number): Position => [round(clamp(dem.bounds[0] + (i / (width - 1)) * (dem.bounds[2] - dem.bounds[0]), dem.bounds[0], dem.bounds[2])), round(clamp(dem.bounds[3] - (j / (height - 1)) * (dem.bounds[3] - dem.bounds[1]), dem.bounds[1], dem.bounds[3]))];
      const west = x - 0.5, east = end + 0.5, north = y - 0.5, south = y + 0.5;
      const ring = [p(Math.max(0, west), Math.max(0, north)), p(Math.min(width - 1, east), Math.max(0, north)), p(Math.min(width - 1, east), Math.min(height - 1, south)), p(Math.max(0, west), Math.min(height - 1, south))];
      out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, properties: { kind: 'hillshade', tone: tone as 'shadow' | 'light', opacity: Math.round((Number(step) / steps) * (tone === 'shadow' ? 0.45 : 0.25) * 100) / 100 } });
      x = end + 1;
    }
  }
  return out;
}
