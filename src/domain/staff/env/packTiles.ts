// The map tiles of a synthetic pack (pack version 2): which tiles exist and their pixels. Pure: no I/O, no clock, no vscode; the generator script
// (scripts/generate-env-pack.mjs --tiles) encodes the pixels (WebP for imagery, PNG for heights) and writes the files and tiles/index.json.
//
// Four sets, each with its own zoom range and bounds, so MapLibre never asks for a tile that is not there:
//   imagery         z5-10 over the whole frame (and transparent beyond it, feathered at the edge, so the world imagery shows through)
//   imagery-detail  z11-13 over the land box only; its outer kilometre fades out, so open sea comes from the lower zooms without a seam
//   terrain         Terrarium heights z5-11 over the DEM box with the sea at 0 m: the 3D surface (the imagery's water must not sag into the seabed)
//   relief          Terrarium heights z5-11 over the DEM box with the sea floor: hillshade and the topographic map's colour relief
// Heights come from the pack's DEM through a bicubic sampler and are rounded to a quarter metre; no detail is added, so the contours the host draws
// from the same DEM lie on the 3D surface.
import { gridToWgs84 } from '../obs/frame';
import type { ExerciseFrame } from '../obs/frame';
import { demSampler, kmToLonlat } from './landcover';
import type { KmBox, Landcover } from './landcover';
import { DEM_BOX } from './synthetic';
import { SYNTHETIC_OUTLINES } from '../cop/geography';
import type { Scenario } from '../scenario';
import { downsampleTiles, IMAGERY_MAX_ZOOM, imageryRenderer } from './imagery';
import type { ImageryRenderer } from './imagery';
import type { Bounds, Coastline, Dem } from './pack';
import { terrariumEncode, tilesCovering, TILE_SIZE, tileXToLon, tileYToLat } from './tiles';
import type { TileFormat } from './tiles';

export interface PackTileSet { readonly id: string; readonly format: TileFormat; readonly minzoom: number; readonly maxzoom: number; readonly bounds: Bounds }

/** The height step of the Terrarium tiles, in metres. */
export const HEIGHT_STEP_M = 0.25;
/** The width of the detail imagery's fade at the land box's edge, in km. */
export const DETAIL_FADE_KM = 1;

/** The four tile sets of a frame's pack: their zooms and bounds. */
export function packTileSets(frame: ExerciseFrame, box: KmBox, frameBounds: Bounds): PackTileSet[] {
  const sw = kmToLonlat(frame, box.sw, 6), ne = kmToLonlat(frame, box.ne, 6);
  // Rounded inwards, so a set's bounds never reach past the pack's.
  const boxBounds: Bounds = [sw[0], sw[1], ne[0], ne[1]];
  return [
    { id: 'imagery', format: 'webp', minzoom: 5, maxzoom: 10, bounds: frameBounds },
    { id: 'imagery-detail', format: 'webp', minzoom: 11, maxzoom: IMAGERY_MAX_ZOOM, bounds: boxBounds },
    { id: 'terrain', format: 'png', minzoom: 5, maxzoom: 11, bounds: boxBounds },
    { id: 'relief', format: 'png', minzoom: 5, maxzoom: 11, bounds: boxBounds }
  ];
}

/** Every tile of a set, as [z, x, y], zoom by zoom. */
export function setTiles(set: PackTileSet): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let z = set.minzoom; z <= set.maxzoom; z += 1) for (const [x, y] of tilesCovering(set.bounds, z)) out.push([z, x, y]);
  return out;
}

/** A height tile as RGB Terrarium pixels (and the RGBA its digest is taken of). `seaLevel` clamps every height below 0 m to 0 m (the 3D surface). */
export function heightTile(frame: ExerciseFrame, dem: Dem, z: number, x: number, y: number, seaLevel: boolean): { readonly rgb: Uint8Array; readonly rgba: Uint8Array } {
  const height = demSampler(frame, dem, true);
  const origin = gridToWgs84(frame, { eastingMetres: 0, northingMetres: 0 });
  const one = gridToWgs84(frame, { eastingMetres: 1000, northingMetres: 1000 });
  const kmPerLon = 1 / (one.longitude - origin.longitude), kmPerLat = 1 / (one.latitude - origin.latitude);
  const rgb = new Uint8Array(TILE_SIZE * TILE_SIZE * 3), rgba = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  for (let py = 0; py < TILE_SIZE; py += 1) {
    const ky = (tileYToLat(y + (py + 0.5) / TILE_SIZE, z) - origin.latitude) * kmPerLat;
    for (let px = 0; px < TILE_SIZE; px += 1) {
      const kx = (tileXToLon(x + (px + 0.5) / TILE_SIZE, z) - origin.longitude) * kmPerLon;
      const h = height(kx, ky);
      const [r, g, b] = terrariumEncode(seaLevel ? Math.max(0, h) : h, HEIGHT_STEP_M);
      const p = py * TILE_SIZE + px;
      rgb[p * 3] = r; rgb[p * 3 + 1] = g; rgb[p * 3 + 2] = b;
      rgba[p * 4] = r; rgba[p * 4 + 1] = g; rgba[p * 4 + 2] = b; rgba[p * 4 + 3] = 255;
    }
  }
  return { rgb, rgba };
}

/**
 * Renders the imagery tiles of both imagery sets, calling `emit` for each wanted tile. Only the deepest zoom is drawn; every lower tile is the
 * average of the four under it, so all zooms agree. `wanted` (optional) limits which tiles are emitted (a sample check); the pyramid still renders
 * only the branches that lead to a wanted tile.
 */
export function renderImagery(renderer: ImageryRenderer, sets: readonly PackTileSet[], emit: (set: PackTileSet, z: number, x: number, y: number, rgba: Uint8ClampedArray) => void, wanted?: (set: string, z: number, x: number, y: number) => boolean): void {
  const imagery = sets.filter((set) => set.format === 'webp');
  const want = (z: number, x: number, y: number) => imagery.filter((set) => z >= set.minzoom && z <= set.maxzoom && tilesCovering(set.bounds, z).some(([a, b]) => a === x && b === y) && (!wanted || wanted(set.id, z, x, y)));
  // Whether any wanted tile lies at or under z/x/y.
  const leads = (z: number, x: number, y: number): boolean => {
    for (const set of imagery) for (let zz = Math.max(z, set.minzoom); zz <= set.maxzoom; zz += 1) {
      const scale = 2 ** (zz - z);
      for (const [a, b] of tilesCovering(set.bounds, zz)) if (Math.floor(a / scale) === x && Math.floor(b / scale) === y && (!wanted || wanted(set.id, zz, a, b))) return true;
    }
    return false;
  };
  const top = imagery.reduce((m, set) => Math.min(m, set.minzoom), 99);
  const outer = imagery.reduce<Bounds>((b, set) => [Math.min(b[0], set.bounds[0]), Math.min(b[1], set.bounds[1]), Math.max(b[2], set.bounds[2]), Math.max(b[3], set.bounds[3])], [180, 90, -180, -90]);
  // force: an ancestor is emitted, so this tile's pixels are needed for its average even if this tile is not emitted itself.
  const build = (z: number, x: number, y: number, force: boolean): Uint8ClampedArray | undefined => {
    const west = tileXToLon(x, z), east = tileXToLon(x + 1, z), north = tileYToLat(y, z), south = tileYToLat(y + 1, z);
    if (east <= outer[0] || west >= outer[2] || north <= outer[1] || south >= outer[3]) return undefined;
    const here = want(z, x, y);
    const need = force || here.length > 0;
    if (!need && !leads(z, x, y)) return undefined;
    let rgba: Uint8ClampedArray | undefined;
    if (z === IMAGERY_MAX_ZOOM) rgba = need ? renderer.tile(z, x, y) : undefined;
    else {
      const children = [build(z + 1, 2 * x, 2 * y, need), build(z + 1, 2 * x + 1, 2 * y, need), build(z + 1, 2 * x, 2 * y + 1, need), build(z + 1, 2 * x + 1, 2 * y + 1, need)];
      rgba = need ? downsampleTiles(children) : undefined;
    }
    if (rgba) for (const set of here) emit(set, z, x, y, set.id === 'imagery-detail' ? fadeDetail(renderer, set, z, x, y, rgba) : rgba);
    return rgba;
  };
  for (const [x, y] of tilesCovering(outer, top)) build(top, x, y, false);
}

/** The detail imagery fades out over its last kilometre inside its bounds, so the lower zooms' sea shows through without a seam. */
function fadeDetail(renderer: ImageryRenderer, set: PackTileSet, z: number, x: number, y: number, rgba: Uint8ClampedArray): Uint8ClampedArray {
  const { xs, ys } = renderer.pixelKm(z, x, y);
  const [w, s] = renderer.lonLatKm(set.bounds[0], set.bounds[1]), [e, n] = renderer.lonLatKm(set.bounds[2], set.bounds[3]);
  const out = new Uint8ClampedArray(rgba);
  for (let py = 0; py < TILE_SIZE; py += 1) for (let px = 0; px < TILE_SIZE; px += 1) {
    const inside = Math.min(xs[px] - w, e - xs[px], ys[py] - s, n - ys[py]);
    const f = Math.max(0, Math.min(1, inside / DETAIL_FADE_KM));
    const k = (py * TILE_SIZE + px) * 4 + 3;
    out[k] = Math.round(out[k] * f * f * (3 - 2 * f));
  }
  return out;
}

/** The imagery renderer of a synthetic pack: its DEM, land polygons and land cover, and the scenario outline's rivers. */
export function packImageryRenderer(scenario: Pick<Scenario, 'id' | 'region'>, pack: { readonly dem: Dem; readonly coastline: Coastline; readonly landcover: Landcover }, seed: number): ImageryRenderer | undefined {
  const frame = scenario.region.frame;
  const outline = SYNTHETIC_OUTLINES[scenario.id];
  if (!frame || !outline) return undefined;
  const land = pack.coastline.features.flatMap((feature) => (feature.properties.kind === 'land' && feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : []));
  return imageryRenderer({ frame, dem: pack.dem, land, landcover: pack.landcover, rivers: outline.rivers.map((river) => river.path), box: DEM_BOX, seed });
}
