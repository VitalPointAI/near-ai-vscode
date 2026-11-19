// Synthetic aerial imagery for a scenario's exercise frame (pack version 2, tiles/imagery and tiles/imagery-detail): what the land cover, the DEM and
// the coastline would look like from a satellite, drawn per pixel. Pure: no I/O, no clock, no vscode. Nothing here is a real place.
//
// Recipe (research note, section 4):
//   - Every pixel is computed from its position in km east and north of the frame origin, never from tile-local coordinates, so tiles and zooms meet
//     without seams. Only the deepest zoom (13, about 12.5 m a pixel here) is drawn; each lower zoom is the average of the four tiles under it.
//   - The class comes from landcover.geojson and the coastline rasterised on a 10 m grid, looked up through a gentle noise warp so edges are organic.
//   - Colour per class in the muted tones of true-colour satellite imagery in late autumn, varied by domain noise; fields are a seeded Voronoi
//     patchwork with hedgerows, woods have crown texture, towns have streets and roofs, the sea shades from turquoise shallows to deep blue.
//   - Light is baked in: hillshade from the DEM (sun in the north-west at 45 degrees) and fine relief from noise, because MapLibre does not light the
//     draped terrain.
//   - Roads, tracks and rivers are drawn by distance to their lines, anti-aliased, at their real widths.
//   - Outside the frame the tiles are transparent, with a 3 km feathered edge that also fades to the world imagery's deep-ocean colour, so the globe
//     shows through with no seam.
// All noise is integer-hashed (noise.ts), so the same inputs give the same pixels on every machine.
import { gridToWgs84 } from '../obs/frame';
import type { ExerciseFrame } from '../obs/frame';
import type { Dem } from './pack';
import type { Landcover, KmBox } from './landcover';
import { demSampler, fillPolygon } from './landcover';
import { fbm, hash2, valueNoise } from './noise';
import { TILE_SIZE, tileXToLon, tileYToLat } from './tiles';

type Km = readonly [number, number];

/** The deepest zoom drawn; lower zooms are averages of it. */
export const IMAGERY_MAX_ZOOM = 13;
/** The colour of the open ocean in the bundled world imagery near the frame, which the frame's feathered edge fades to. */
export const DEEP_OCEAN = [12, 30, 58] as const;
/** The feathered edge of the frame imagery, in km. */
export const FRAME_FEATHER_KM = 3;

const enum C { Sea = 0, Grass = 1, Farmland = 2, Scrub = 3, Forest = 4, Rock = 5, Beach = 6, Marsh = 7, Built = 8 }
const AREA_CLASS: Record<string, C> = { farmland: C.Farmland, scrub: C.Scrub, forest: C.Forest, rock: C.Rock, beach: C.Beach, marsh: C.Marsh, 'built-up': C.Built };
/** Drawing order: later classes win where shapes overlap after smoothing. */
const AREA_ORDER = ['farmland', 'scrub', 'forest', 'rock', 'beach', 'marsh', 'built-up'];

export interface ImageryInputs {
  readonly frame: ExerciseFrame;
  /** The DEM with true heights (sea floor included). */
  readonly dem: Dem;
  /** Land polygons in [longitude, latitude] (the pack's coastline.geojson land features). */
  readonly land: ReadonlyArray<ReadonlyArray<ReadonlyArray<readonly [number, number]>>>;
  readonly landcover: Landcover;
  /** Rivers in km east and north of the frame origin, from source to mouth. */
  readonly rivers: ReadonlyArray<readonly Km[]>;
  /** The box the land lies in (the DEM's), in km. */
  readonly box: KmBox;
  readonly seed: number;
}

export interface ImageryRenderer {
  /** The RGBA pixels of tile z/x/y at the deepest zoom (IMAGERY_MAX_ZOOM). */
  tile(z: number, x: number, y: number): Uint8ClampedArray;
  /** The frame's opacity at a point in km: 1 inside, 0 outside, feathered at the edge. */
  frameAlpha(x: number, y: number): number;
  /** Pixel centre positions of a tile in km, for alpha shaping by the caller. */
  pixelKm(z: number, x: number, y: number): { readonly xs: Float64Array; readonly ys: Float64Array };
  /** A [longitude, latitude] in km east and north of the frame origin. */
  lonLatKm(lon: number, lat: number): readonly [number, number];
}

const smoothstep = (a: number, b: number, t: number) => { const u = Math.max(0, Math.min(1, (t - a) / (b - a))); return u * u * (3 - 2 * u); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function mixRgb(out: RGB, b: readonly number[], t: number): void { out[0] += (b[0] - out[0]) * t; out[1] += (b[1] - out[1]) * t; out[2] += (b[2] - out[2]) * t; }

const PAL = {
  deep: hex('#0b2742'), mid: hex('#174a62'), shallow: hex('#3f8288'), surf: hex('#c9d4d0'),
  sandDry: hex('#c2b38e'), sandWet: hex('#8d8066'),
  grassA: hex('#69753f'), grassB: hex('#7d7f4b'), grassC: hex('#58683a'),
  fields: [hex('#5f6e3a'), hex('#6a7840'), hex('#566634'), hex('#7b8049'), hex('#64713d'), hex('#9c9467'), hex('#8f8659'), hex('#6e5a43'), hex('#7c6a50'), hex('#727a47')],
  pasture: [hex('#61703b'), hex('#6b7942'), hex('#5a6936'), hex('#747c47'), hex('#687540')],
  hedge: hex('#344128'),
  conifer: hex('#2b3a24'), coniferLight: hex('#3b4b2e'), autumn: hex('#55512f'), autumnLight: hex('#6c6239'),
  scrubA: hex('#686646'), scrubB: hex('#58563a'), bush: hex('#3f4630'),
  rockA: hex('#7d776d'), rockB: hex('#5f5a54'),
  marsh: hex('#55603f'), marshWater: hex('#34484a'), reed: hex('#8a7f55'),
  roofs: [hex('#8b8681'), hex('#7d5e52'), hex('#75777b'), hex('#8d786c'), hex('#6c6762'), hex('#9a958d')],
  flatRoofs: [hex('#b4b1ab'), hex('#9fa3a6'), hex('#8c8a86')],
  street: hex('#8f8b85'), garden: hex('#5f6d42'),
  road: hex('#5d5b58'), verge: hex('#8a8670'), track: hex('#9e8f70'), river: hex('#2b4549'),
  haze: hex('#9aa8b0'), shadow: hex('#1b2416')
};

interface Segment { readonly ax: number; readonly ay: number; readonly bx: number; readonly by: number; readonly kind: 0 | 1 | 2 | 3; readonly w0: number; readonly w1: number }

/** Builds the per-pixel renderer for a frame. Preparation rasterises the land cover once (about 35 MB for a 58 km box). */
export function imageryRenderer(input: ImageryInputs): ImageryRenderer {
  const { frame, box, seed } = input;
  const origin = gridToWgs84(frame, { eastingMetres: 0, northingMetres: 0 });
  const one = gridToWgs84(frame, { eastingMetres: 1000, northingMetres: 1000 });
  const kmPerLon = 1 / (one.longitude - origin.longitude), kmPerLat = 1 / (one.latitude - origin.latitude);
  const toKm = (lon: number, lat: number): Km => [(lon - origin.longitude) * kmPerLon, (lat - origin.latitude) * kmPerLat];
  const side: Km = [frame.extent.eastings * frame.squareMetres / 1000, frame.extent.northings * frame.squareMetres / 1000];
  const height = demSampler(frame, input.dem);
  const smoothHeight = demSampler(frame, input.dem, true);

  // ---- The class raster: 10 m cells over the land box ----
  const cell = 0.01;
  const W = Math.round((box.ne[0] - box.sw[0]) / cell), H = Math.round((box.ne[1] - box.sw[1]) / cell);
  const cls = new Uint8Array(W * H);
  const toCell = (lon: number, lat: number): [number, number] => { const [x, y] = toKm(lon, lat); return [(x - box.sw[0]) / cell, (box.ne[1] - y) / cell]; };
  for (const rings of input.land) fillPolygon(cls, W, H, toCell, rings, C.Grass);
  const land = new Uint8Array(cls);
  for (const kind of AREA_ORDER) for (const feature of input.landcover.features) {
    if (feature.properties.kind !== kind || feature.geometry.type !== 'Polygon') continue;
    fillPolygon(cls, W, H, toCell, feature.geometry.coordinates, AREA_CLASS[kind]);
  }
  // Area classes only on land (the coastline is the one true shore).
  for (let k = 0; k < cls.length; k += 1) if (!land[k]) cls[k] = C.Sea;

  // ---- Distance to the shore in km on a 25 m grid, positive at sea and negative on land ----
  const dc = 0.025;
  const DW = Math.round((box.ne[0] - box.sw[0]) / dc) + 1, DH = Math.round((box.ne[1] - box.sw[1]) / dc) + 1;
  const isLandAt = (x: number, y: number) => { const i = Math.floor((x - box.sw[0]) / cell), j = Math.floor((box.ne[1] - y) / cell); return i >= 0 && j >= 0 && i < W && j < H && land[j * W + i] === 1; };
  const chamfer = (inside: (k: number) => boolean) => {
    const d = new Float32Array(DW * DH);
    for (let k = 0; k < d.length; k += 1) d[k] = inside(k) ? 1e9 : 0;
    const a = dc, b = dc * Math.SQRT2;
    for (let j = 0; j < DH; j += 1) for (let i = 0; i < DW; i += 1) {
      const k = j * DW + i; let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + a);
      if (j > 0) { v = Math.min(v, d[k - DW] + a); if (i > 0) v = Math.min(v, d[k - DW - 1] + b); if (i < DW - 1) v = Math.min(v, d[k - DW + 1] + b); }
      d[k] = v;
    }
    for (let j = DH - 1; j >= 0; j -= 1) for (let i = DW - 1; i >= 0; i -= 1) {
      const k = j * DW + i; let v = d[k];
      if (i < DW - 1) v = Math.min(v, d[k + 1] + a);
      if (j < DH - 1) { v = Math.min(v, d[k + DW] + a); if (i < DW - 1) v = Math.min(v, d[k + DW + 1] + b); if (i > 0) v = Math.min(v, d[k + DW - 1] + b); }
      d[k] = v;
    }
    return d;
  };
  const landD = new Uint8Array(DW * DH);
  for (let j = 0; j < DH; j += 1) for (let i = 0; i < DW; i += 1) landD[j * DW + i] = isLandAt(box.sw[0] + i * dc, box.ne[1] - j * dc) ? 1 : 0;
  const seaDist = chamfer((k) => landD[k] === 0);
  const landDist = chamfer((k) => landD[k] === 1);
  const sample = (field: Float32Array, x: number, y: number) => {
    const gx = Math.max(0, Math.min(DW - 1.001, (x - box.sw[0]) / dc)), gy = Math.max(0, Math.min(DH - 1.001, (box.ne[1] - y) / dc));
    const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j, k = j * DW + i;
    return mix(mix(field[k], field[k + 1], fx), mix(field[k + DW], field[k + DW + 1], fx), fy);
  };
  /** Signed distance to the shore in km: positive at sea. Outside the box the land is at least the distance to the box away. */
  const shore = (x: number, y: number) => {
    const out = Math.max(box.sw[0] - x, x - box.ne[0], box.sw[1] - y, y - box.ne[1], 0);
    return sample(seaDist, x, y) - sample(landDist, x, y) + out;
  };

  // ---- Lines: roads, tracks and rivers, bucketed by 250 m cells for the distance lookups ----
  const segments: Segment[] = [];
  const addLine = (points: readonly Km[], kind: Segment['kind'], w0: number, w1: number) => {
    for (let i = 1; i < points.length; i += 1) {
      const t0 = (i - 1) / (points.length - 1), t1 = i / (points.length - 1);
      segments.push({ ax: points[i - 1][0], ay: points[i - 1][1], bx: points[i][0], by: points[i][1], kind, w0: mix(w0, w1, t0), w1: mix(w0, w1, t1) });
    }
  };
  for (const feature of input.landcover.features) {
    if (feature.geometry.type !== 'LineString') continue;
    const pts = feature.geometry.coordinates.map(([lon, lat]) => toKm(lon, lat));
    if (feature.properties.kind === 'road') addLine(pts, feature.properties.minor ? 1 : 0, feature.properties.minor ? 0.0065 : 0.0095, feature.properties.minor ? 0.0065 : 0.0095);
    else addLine(pts, 2, 0.0042, 0.0042);
  }
  for (const river of input.rivers) addLine(river, 3, 0.006, 0.026);
  const bucket = 0.25;
  const BW = Math.ceil((box.ne[0] - box.sw[0]) / bucket) + 1, BH = Math.ceil((box.ne[1] - box.sw[1]) / bucket) + 1;
  const buckets: number[][] = Array.from({ length: BW * BH }, () => []);
  segments.forEach((s, index) => {
    const pad = 0.05;
    const i0 = Math.max(0, Math.floor((Math.min(s.ax, s.bx) - pad - box.sw[0]) / bucket)), i1 = Math.min(BW - 1, Math.floor((Math.max(s.ax, s.bx) + pad - box.sw[0]) / bucket));
    const j0 = Math.max(0, Math.floor((box.ne[1] - Math.max(s.ay, s.by) - pad) / bucket)), j1 = Math.min(BH - 1, Math.floor((box.ne[1] - Math.min(s.ay, s.by) + pad) / bucket));
    for (let j = j0; j <= j1; j += 1) for (let i = i0; i <= i1; i += 1) buckets[j * BW + i].push(index);
  });

  // ---- Towns: a street grid per built-up area, turned to its own angle ----
  const townAngle = (x: number, y: number) => (hash2(Math.floor(x / 3), Math.floor(y / 3), seed + 5) - 0.5) * 0.9;

  const classAt = (x: number, y: number): C => {
    // A gentle warp (about 15 m) so raster edges read as natural boundaries.
    const wx = x + 0.015 * valueNoise(x / 0.06, y / 0.06, seed + 101), wy = y + 0.015 * valueNoise(x / 0.06 + 17.3, y / 0.06, seed + 102);
    const i = Math.floor((wx - box.sw[0]) / cell), j = Math.floor((box.ne[1] - wy) / cell);
    if (i < 0 || j < 0 || i >= W || j >= H) return C.Sea;
    const c = cls[j * W + i] as C;
    // Keep the true shore: the warp never moves land into the sea or back.
    const ii = Math.floor((x - box.sw[0]) / cell), jj = Math.floor((box.ne[1] - y) / cell);
    const onLand = ii >= 0 && jj >= 0 && ii < W && jj < H && land[jj * W + ii] === 1;
    if (!onLand) return C.Sea;
    return c === C.Sea ? C.Grass : c;
  };

  /** Micro relief in metres for the baked light: canopy, rocks and field furrows, by class. */
  const micro = (x: number, y: number, c: C) => {
    switch (c) {
      case C.Forest: return 7 * fbm(x / 0.03, y / 0.03, seed + 201, 3) + 3 * valueNoise(x / 0.012, y / 0.012, seed + 202);
      case C.Rock: return 9 * fbm(x / 0.05, y / 0.05, seed + 203, 4);
      case C.Scrub: return 2.5 * fbm(x / 0.03, y / 0.03, seed + 204, 3);
      case C.Built: return 0;
      case C.Sea: return 0;
      default: return 1.5 * fbm(x / 0.12, y / 0.12, seed + 205, 3);
    }
  };

  const sun = (() => { const az = (315 * Math.PI) / 180, alt = (45 * Math.PI) / 180; return [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)]; })();
  /** Lambert shade relative to flat ground, from a height function (metres) at km positions. */
  const shadeFrom = (dzdx: number, dzdy: number) => {
    const nx = -dzdx, ny = -dzdy, len = Math.sqrt(nx * nx + ny * ny + 1);
    return Math.max(0, (nx * sun[0] + ny * sun[1] + sun[2]) / len) / sun[2];
  };

  /**
   * Fields: rows of rectangles along a field-system bearing that bends slowly across the land (never jumps), each row offset and each field its own
   * length, with hedgerows on most boundaries. `pasture` keeps to greens and fainter hedges (enclosed grassland); otherwise the late-autumn mix of
   * green winter crops, pale stubble and brown ploughland.
   */
  function fieldColour(out: RGB, x: number, y: number, pasture: boolean): void {
    // One bearing for the whole field system, bent gently by a slow warp, so rows curve with the land but never fan out.
    const wx = x + 0.6 * valueNoise(x / 9, y / 9, seed + 310), wy = y + 0.6 * valueNoise(x / 9 + 31.7, y / 9, seed + 319);
    const a = 0.42, ca = Math.cos(a), sa = Math.sin(a);
    const u = wx * ca + wy * sa, v = -wx * sa + wy * ca;
    const rowH = 0.24, row = Math.floor(v / rowH);
    const len = 0.3 + 0.4 * hash2(row, 1, seed + 311);
    const shift = hash2(row, 2, seed + 312) * len;
    const col = Math.floor((u + shift) / len);
    const id = row * 7919 + col;
    const r = hash2(id, 3, seed + 313);
    const palette = pasture ? PAL.pasture : PAL.fields;
    const pick = palette[Math.floor(r * palette.length)];
    out[0] = pick[0]; out[1] = pick[1]; out[2] = pick[2];
    const fu = (u + shift) / len - col, fv = v / rowH - row;
    // Drill lines and a soft unevenness inside the field.
    const lines = Math.sin(((pasture ? v : u) / 0.024) * Math.PI * 2) * (pasture ? 0.01 : 0.025);
    const vary = 1 + 0.06 * fbm(x / 0.12, y / 0.12, seed + 314, 3) + lines + 0.03 * valueNoise(x / 0.02, y / 0.02, seed + 315);
    out[0] *= vary; out[1] *= vary; out[2] *= vary;
    // Hedgerows on most boundaries: dark, broken, with the odd tree.
    const du = Math.min(fu, 1 - fu) * len, dv = Math.min(fv, 1 - fv) * rowH;
    const hedgeU = hash2(id, 4, seed + 316) < (pasture ? 0.55 : 0.7), hedgeV = hash2(row, 5, seed + 317) < (pasture ? 0.6 : 0.8);
    const d = Math.min(hedgeU ? du : 1, hedgeV ? dv : 1);
    if (d < 0.012) {
      const broken = 0.5 + 0.5 * valueNoise(x / 0.025, y / 0.025, seed + 318);
      mixRgb(out, PAL.hedge, (1 - smoothstep(0.003, 0.012, d)) * broken * 0.85);
    }
  }

  function landColour(out: RGB, x: number, y: number, c: C): void {
    const n1 = fbm(x / 0.35, y / 0.35, seed + 301, 4), n2 = valueNoise(x / 0.018, y / 0.018, seed + 302);
    switch (c) {
      case C.Grass: {
        fieldColour(out, x, y, true);
        // Rough grazing in places: the field pattern fades into open grass.
        const open = smoothstep(0.05, 0.45, fbm(x / 1.6, y / 1.6, seed + 303, 3));
        const g: RGB = [PAL.grassA[0], PAL.grassA[1], PAL.grassA[2]];
        mixRgb(g, PAL.grassB, smoothstep(-0.3, 0.6, n1));
        mixRgb(out, g, open);
        const v = 1 + 0.04 * n2; out[0] *= v; out[1] *= v; out[2] *= v;
        break;
      }
      case C.Farmland: fieldColour(out, x, y, false); break;
      case C.Forest: {
        const deciduous = smoothstep(0.25, 0.65, fbm(x / 0.7, y / 0.7, seed + 320, 3));
        out[0] = mix(PAL.conifer[0], PAL.autumn[0], deciduous); out[1] = mix(PAL.conifer[1], PAL.autumn[1], deciduous); out[2] = mix(PAL.conifer[2], PAL.autumn[2], deciduous);
        // Crowns: lit tops and dark gaps on a jittered 14 m lattice, and clearings of a lighter tone.
        const gx = x / 0.014, gy = y / 0.014, ix = Math.floor(gx), iy = Math.floor(gy);
        let best = 9;
        for (let b = -1; b <= 1; b += 1) for (let q = -1; q <= 1; q += 1) {
          const cx = ix + q + hash2(ix + q, iy + b, seed + 321), cy = iy + b + hash2(ix + q, iy + b, seed + 322);
          best = Math.min(best, Math.hypot(gx - cx, gy - cy));
        }
        const crown = 1 - smoothstep(0.15, 0.8, best);
        mixRgb(out, deciduous > 0.5 ? PAL.autumnLight : PAL.coniferLight, crown * 0.7);
        mixRgb(out, PAL.shadow, (1 - smoothstep(0.7, 1.1, best)) * 0 + smoothstep(0.75, 1.05, best) * 0.5);
        mixRgb(out, PAL.scrubB, smoothstep(0.45, 0.7, fbm(x / 0.25, y / 0.25, seed + 323, 3)) * 0.5);
        const v = 0.9 + 0.2 * fbm(x / 0.12, y / 0.12, seed + 324, 3) + 0.06 * n1; out[0] *= v; out[1] *= v; out[2] *= v;
        break;
      }
      case C.Scrub: {
        out[0] = PAL.scrubA[0]; out[1] = PAL.scrubA[1]; out[2] = PAL.scrubA[2];
        mixRgb(out, PAL.scrubB, smoothstep(-0.2, 0.5, n1));
        mixRgb(out, PAL.grassB, smoothstep(0.2, 0.6, fbm(x / 0.5, y / 0.5, seed + 331, 3)) * 0.5);
        const bushes = hash2(Math.floor(x / 0.016), Math.floor(y / 0.016), seed + 330);
        if (bushes > 0.7) mixRgb(out, PAL.bush, 0.55);
        break;
      }
      case C.Rock: {
        // Outcrops in heath: bare rock where the noise says so, lichen and heather between.
        out[0] = PAL.scrubB[0]; out[1] = PAL.scrubB[1]; out[2] = PAL.scrubB[2];
        const bare = smoothstep(-0.15, 0.35, fbm(x / 0.09, y / 0.09, seed + 340, 4));
        const stone: RGB = [PAL.rockA[0], PAL.rockA[1], PAL.rockA[2]];
        mixRgb(stone, PAL.rockB, smoothstep(-0.3, 0.4, fbm(x / 0.03, y / 0.03, seed + 341, 3)));
        mixRgb(out, stone, bare);
        const v = 1 + 0.08 * n2; out[0] *= v; out[1] *= v; out[2] *= v;
        break;
      }
      case C.Beach: {
        const wet = 1 - smoothstep(0.004, 0.035, -shore(x, y));
        out[0] = PAL.sandDry[0]; out[1] = PAL.sandDry[1]; out[2] = PAL.sandDry[2];
        mixRgb(out, PAL.sandWet, wet * 0.85);
        mixRgb(out, PAL.scrubA, smoothstep(0.035, 0.09, -shore(x, y)) * 0.6);
        const v = 1 + 0.04 * n2; out[0] *= v; out[1] *= v; out[2] *= v;
        break;
      }
      case C.Marsh: {
        // Reed beds and wet grass, with winding dark channels and a few pools.
        out[0] = PAL.marsh[0]; out[1] = PAL.marsh[1]; out[2] = PAL.marsh[2];
        mixRgb(out, PAL.reed, smoothstep(-0.2, 0.4, fbm(x / 0.2, y / 0.2, seed + 351, 3)) * 0.7);
        const channel = Math.abs(fbm(x / 0.35, y / 0.35, seed + 352, 3));
        mixRgb(out, PAL.marshWater, (1 - smoothstep(0.015, 0.05, channel)) * 0.85);
        mixRgb(out, PAL.marshWater, smoothstep(0.42, 0.55, fbm(x / 0.09, y / 0.09, seed + 350, 3)));
        const v = 1 + 0.05 * n2; out[0] *= v; out[1] *= v; out[2] *= v;
        break;
      }
      case C.Built: {
        // Blocks between streets on the town's own grid, roofs and gardens mixed at the scale of a few houses, bigger buildings near the centre.
        const a = townAngle(x, y), ca = Math.cos(a), sa = Math.sin(a);
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        const bv = 0.12, rowB = Math.floor(v / bv);
        const bu = 0.13 + 0.08 * hash2(rowB, 1, seed + 364), shiftB = hash2(rowB, 2, seed + 365) * bu;
        const colB = Math.floor((u + shiftB) / bu);
        const fu = ((u + shiftB) / bu - colB) * bu, fv = (v / bv - rowB) * bv;
        const street = 0.013;
        const centre = smoothstep(-0.1, 0.6, fbm(x / 0.9, y / 0.9, seed + 361));
        if (fu < street || fv < street) {
          out[0] = PAL.street[0]; out[1] = PAL.street[1]; out[2] = PAL.street[2];
          if (fu < street * 0.25 || fv < street * 0.25) mixRgb(out, PAL.garden, 0.2);
        } else if (hash2(colB, rowB, seed + 366) < 0.03 + 0.08 * centre) {
          const big = PAL.flatRoofs[Math.floor(hash2(colB, rowB, seed + 367) * PAL.flatRoofs.length)];
          out[0] = big[0]; out[1] = big[1]; out[2] = big[2];
          const v2 = 1 + 0.04 * n2; out[0] *= v2; out[1] *= v2; out[2] *= v2;
        } else {
          // Houses along the block's edges (the street fronts), gardens behind; each block has its own roof tones.
          const inner = Math.min(fu - street, bu - fu, fv - street, bv - fv);
          const lu = Math.floor(u / 0.019), lv = Math.floor(v / 0.016);
          const front = inner < 0.022 + 0.02 * centre;
          const roofy = front ? hash2(lu, lv, seed + 360) < 0.8 : smoothstep(0.1, 0.5, valueNoise(x / 0.035, y / 0.035, seed + 368)) + centre * 0.6 > 0.5;
          if (roofy) {
            const roof = PAL.roofs[Math.floor(hash2(colB, rowB * 3 + (hash2(lu, lv, seed + 362) < 0.25 ? 1 : 0), seed + 369) * PAL.roofs.length)];
            out[0] = roof[0]; out[1] = roof[1]; out[2] = roof[2];
            const tone = 0.94 + 0.12 * hash2(lu, lv, seed + 370); out[0] *= tone; out[1] *= tone; out[2] *= tone;
          } else {
            out[0] = PAL.garden[0]; out[1] = PAL.garden[1]; out[2] = PAL.garden[2];
            mixRgb(out, PAL.conifer, smoothstep(0.1, 0.6, valueNoise(x / 0.012, y / 0.012, seed + 363)) * 0.6);
          }
          mixRgb(out, PAL.street, 0.18);
        }
        break;
      }
      default: out[0] = PAL.grassA[0]; out[1] = PAL.grassA[1]; out[2] = PAL.grassA[2];
    }
  }

  function seaColour(out: RGB, x: number, y: number, s: number): void {
    // Depth: the DEM inside its box, a shelf near the shore, and the generator's own falloff with distance beyond.
    const inBox = x >= box.sw[0] && x <= box.ne[0] && y >= box.sw[1] && y <= box.ne[1];
    const fromDem = inBox ? -height(x, y) : 3 + 60 * (1 - Math.exp(-s / 5));
    const shelf = 0.6 + s * (22 + 18 * fbm(x / 1.5, y / 1.5, seed + 405, 3)) + 3 * fbm(x / 0.25, y / 0.25, seed + 401, 3);
    const depth = Math.max(0.4, Math.min(Math.max(fromDem, 2), shelf));
    const t = 1 - Math.exp(-depth / 9);
    out[0] = PAL.shallow[0]; out[1] = PAL.shallow[1]; out[2] = PAL.shallow[2];
    mixRgb(out, PAL.mid, smoothstep(0, 0.6, t));
    mixRgb(out, PAL.deep, smoothstep(0.5, 1, t));
    // Wind streaks and swell, long along the south-westerly, kept faint so deep water stays calm at every zoom.
    const a = 0.9, u = x * Math.cos(a) + y * Math.sin(a), v = -x * Math.sin(a) + y * Math.cos(a);
    const streak = 0.035 * fbm(u / 1.2, v / 0.15, seed + 402, 3) + 0.015 * valueNoise(u / 0.05, v / 0.02, seed + 403) * (1 - t);
    out[0] *= 1 + streak; out[1] *= 1 + streak; out[2] *= 1 + streak;
    // Surf on the shore.
    if (s < 0.03) mixRgb(out, PAL.surf, (1 - smoothstep(0.004, 0.03, s)) * (0.35 + 0.35 * valueNoise(x / 0.02, y / 0.008, seed + 404)));
  }

  function lineCover(out: RGB, x: number, y: number, pixel: number): void {
    const i = Math.floor((x - box.sw[0]) / bucket), j = Math.floor((box.ne[1] - y) / bucket);
    if (i < 0 || j < 0 || i >= BW || j >= BH) return;
    for (const index of buckets[j * BW + i]) {
      const s = segments[index];
      const dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / l2));
      const d = Math.hypot(x - (s.ax + t * dx), y - (s.ay + t * dy));
      const half = mix(s.w0, s.w1, t) / 2;
      // Coverage of a pixel by the line, anti-aliased over one pixel.
      const cover = Math.max(0, Math.min(1, (half + pixel / 2 - d) / pixel)) * Math.min(1, (2 * half) / pixel + 0.35);
      if (cover <= 0) continue;
      if (s.kind === 3) mixRgb(out, PAL.river, cover);
      else if (s.kind === 2) mixRgb(out, PAL.track, cover * 0.85);
      else {
        const verge = Math.max(0, Math.min(1, (half * 1.8 + pixel / 2 - d) / pixel));
        mixRgb(out, PAL.verge, verge * 0.35);
        mixRgb(out, PAL.road, cover);
      }
    }
  }

  function frameAlpha(x: number, y: number): number {
    const inside = Math.min(x, side[0] - x, y, side[1] - y);
    return smoothstep(0, FRAME_FEATHER_KM, inside);
  }

  function pixelKm(z: number, tx: number, ty: number) {
    const xs = new Float64Array(TILE_SIZE), ys = new Float64Array(TILE_SIZE);
    for (let p = 0; p < TILE_SIZE; p += 1) {
      xs[p] = toKm(tileXToLon(tx + (p + 0.5) / TILE_SIZE, z), origin.latitude)[0];
      ys[p] = toKm(origin.longitude, tileYToLat(ty + (p + 0.5) / TILE_SIZE, z))[1];
    }
    return { xs, ys };
  }

  function tile(z: number, tx: number, ty: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
    const { xs, ys } = pixelKm(z, tx, ty);
    const pixel = Math.abs(xs[1] - xs[0]);
    const rgb: RGB = [0, 0, 0];
    for (let py = 0; py < TILE_SIZE; py += 1) {
      const y = ys[py];
      for (let px = 0; px < TILE_SIZE; px += 1) {
        const x = xs[px];
        const k = (py * TILE_SIZE + px) * 4;
        const alpha = frameAlpha(x, y);
        if (alpha <= 0) continue;
        const s = shore(x, y);
        const c = classAt(x, y);
        if (c === C.Sea) seaColour(rgb, x, y, Math.max(0, s));
        else {
          landColour(rgb, x, y, c);
          // Baked light: the DEM's slope (exaggerated a little so 300 m of relief reads) plus the class's fine relief.
          const e = 0.03;
          const gx = ((smoothHeight(x + e, y) - smoothHeight(x - e, y)) / (2 * e * 1000)) * 4.5, gy = ((smoothHeight(x, y + e) - smoothHeight(x, y - e)) / (2 * e * 1000)) * 4.5;
          const m = 0.006;
          const mx = (micro(x + m, y, c) - micro(x - m, y, c)) / (2 * m * 1000), my = (micro(x, y + m, c) - micro(x, y - m, c)) / (2 * m * 1000);
          const shade = shadeFrom(gx + mx, gy + my);
          const lit = 0.25 + 0.75 * shade;
          rgb[0] *= lit; rgb[1] *= lit; rgb[2] *= lit;
        }
        lineCover(rgb, x, y, pixel);
        // A little atmosphere, as in any image taken from orbit, and the fade to the world imagery at the frame's edge.
        mixRgb(rgb, PAL.haze, 0.06);
        mixRgb(rgb, DEEP_OCEAN, 1 - alpha);
        out[k] = rgb[0]; out[k + 1] = rgb[1]; out[k + 2] = rgb[2]; out[k + 3] = Math.round(alpha * 255);
      }
    }
    return out;
  }

  return { tile, frameAlpha, pixelKm, lonLatKm: toKm };
}

/** Averages four child tiles (top-left, top-right, bottom-left, bottom-right; undefined is transparent) into their parent, alpha-weighted. */
export function downsampleTiles(children: ReadonlyArray<Uint8ClampedArray | undefined>): Uint8ClampedArray | undefined {
  if (children.every((child) => !child)) return undefined;
  const out = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  const half = TILE_SIZE / 2;
  for (let q = 0; q < 4; q += 1) {
    const child = children[q];
    if (!child) continue;
    const ox = (q % 2) * half, oy = Math.floor(q / 2) * half;
    for (let y = 0; y < half; y += 1) for (let x = 0; x < half; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const k = ((2 * y + dy) * TILE_SIZE + 2 * x + dx) * 4;
        const w = child[k + 3];
        r += child[k] * w; g += child[k + 1] * w; b += child[k + 2] * w; a += w;
      }
      const k = ((oy + y) * TILE_SIZE + ox + x) * 4;
      if (a > 0) { out[k] = Math.round(r / a); out[k + 1] = Math.round(g / a); out[k + 2] = Math.round(b / a); out[k + 3] = Math.round(a / 4); }
    }
  }
  return out;
}
