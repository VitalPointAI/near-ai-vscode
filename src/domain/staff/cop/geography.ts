// The synthetic geography the COP draws under the layers when no terrain pack is loaded (research note 11, 6.5; WP-COP): land, a coastline, a river,
// a marsh and contour rings for a scenario's fictional region, placed in its exercise frame over empty ocean. Pure: no I/O, no clock, no vscode.
//
// Nothing here is real: the shapes are drawn by hand to agree with the scenario's own descriptions (Port Calder on the north coast, Beach AMBER at the
// north-west corner, the command ship at sea off Saltmere, Harrow Ridge on the east side above Ashby Ford), and the places come from the scenario's own
// grid references. The terrain packs of WP-ENV replace this with a synthetic DEM, contours and hillshade in the same frame; until then this keeps the map
// offline and readable. Shapes are in kilometres east and north of the frame's origin.
import { gridCentre, gridReferencesIn, gridToWgs84 } from '../obs/frame';
import type { ExerciseFrame } from '../obs/frame';
import type { Scenario } from '../scenario';

type Km = readonly [number, number];

export const GEOGRAPHY_KINDS = ['land', 'marsh', 'contour', 'river', 'road', 'place'] as const;
export type GeographyKind = (typeof GEOGRAPHY_KINDS)[number];

export interface GeographyFeature {
  readonly type: 'Feature';
  readonly geometry: { readonly type: 'Polygon'; readonly coordinates: readonly (readonly (readonly [number, number])[])[] } | { readonly type: 'LineString'; readonly coordinates: readonly (readonly [number, number])[] } | { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
  readonly properties: { readonly kind: GeographyKind; readonly name?: string; readonly height?: number };
}

export interface Geography { readonly type: 'FeatureCollection'; readonly features: readonly GeographyFeature[]; readonly note: string }

export interface Outline {
  readonly land: readonly (readonly Km[])[];
  readonly marsh: readonly (readonly Km[])[];
  readonly rivers: ReadonlyArray<{ readonly name: string; readonly path: readonly Km[] }>;
  /** A ridge as an ellipse: centre, semi-axes along and across it, its bearing from east in degrees, and the heights of its rings. */
  readonly ridges: ReadonlyArray<{ readonly centre: Km; readonly along: number; readonly across: number; readonly degrees: number; readonly rings: readonly number[] }>;
}

/** The hand-drawn outlines of each scenario that has them, by scenario id. */
export const SYNTHETIC_OUTLINES: Readonly<Record<string, Outline>> = {
  'iron-lantern': {
    land: [
      // The Aldmark mainland in the south and the Kestrel Peninsula running north to the Varn Strait.
      [[22, 0], [22, 6], [30, 8], [38, 8.5], [41, 10], [42, 13.5], [41.6, 16], [41.8, 20], [41.3, 24], [41.8, 27.5], [41.2, 31], [40.6, 35], [41.2, 37.2], [43.5, 37.6], [45.5, 37.4], [47, 37.8], [48.8, 37.9], [50.2, 37.2], [51.2, 34], [51, 30], [51.6, 25], [51.2, 20], [51.8, 15], [52.5, 10], [56, 8], [64, 7], [72, 6], [75, 0], [22, 0]],
      // The far shore of the strait, about 8 km north of the peninsula; the Aurel Sea opens to its east.
      [[28, 45.5], [31, 45.1], [34.5, 45.8], [38, 45.2], [41.5, 45.6], [44, 45.1], [46, 45.6], [47.5, 47], [48.6, 48.8], [47.8, 50.6], [48.9, 52.4], [48.2, 54.5], [46.5, 55.6], [43, 56.4], [39, 55.8], [35, 56.6], [31, 55.9], [28.5, 54.2], [27.2, 51.5], [28.3, 49], [27.4, 47.2], [28, 45.5]],
      // Gull Island, in the western mouth of the strait.
      [[40.6, 41.6], [41.5, 41.7], [41.6, 42.5], [40.8, 42.6], [40.6, 41.6]]
    ],
    marsh: [[[42, 25.6], [44.4, 25.6], [44.4, 26.9], [42, 27], [42, 25.6]]],
    rivers: [{ name: 'River Brenn', path: [[47.5, 29], [46.5, 28.6], [45.5, 28.5], [44.5, 27.8], [43, 27.4], [41.8, 27.4]] }],
    ridges: [{ centre: [48, 29], along: 4, across: 1.8, degrees: 72, rings: [100, 200, 300] }]
  }
};

/** A 32-bit integer hash as a number in [0, 1) (the same mixing as env/noise.ts hash2), so the detail is the same on every machine. */
function unit(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A hand-drawn ring with a natural coast: each leg is split six times by seeded midpoint displacement (a fifth of the leg at first, then rougher
 * at the small scale), so straight legs of several kilometres become a coast with bays and headlands, while every hand-drawn point stays where it
 * was. Legs along the frame's edge (where the land runs on outside the frame) stay straight. The map, the terrain pack and the imagery all use this
 * one shape (WP-ENV pack version 2).
 */
export function naturalRing(points: readonly Km[], ringIndex: number, side: Km): Km[] {
  const onEdge = (a: Km, b: Km) => (a[0] === b[0] && (a[0] === 0 || a[0] === side[0])) || (a[1] === b[1] && (a[1] === 0 || a[1] === side[1]));
  const out: Km[] = [];
  for (let leg = 0; leg < points.length - 1; leg += 1) {
    const a = points[leg], b = points[leg + 1];
    let part: Km[] = [a, b];
    if (!onEdge(a, b)) {
      for (let round = 0; round < 6; round += 1) {
        const next: Km[] = [part[0]];
        for (let i = 0; i < part.length - 1; i += 1) {
          const [ax, ay] = part[i], [bx, by] = part[i + 1];
          const length = Math.hypot(bx - ax, by - ay) || 1e-9;
          const offset = (unit(ringIndex * 1000 + leg, round * 4096 + i, 0x51c0a57) * 2 - 1) * (round < 2 ? 0.2 : 0.24) * length;
          next.push([(ax + bx) / 2 - ((by - ay) / length) * offset, (ay + by) / 2 + ((bx - ax) / length) * offset], part[i + 1]);
        }
        part = next;
      }
    }
    out.push(...part.slice(0, -1));
  }
  out.push(points[points.length - 1]);
  return out;
}

/** The outline's land rings with their natural coast (naturalRing), in km. */
export function naturalLand(outline: Pick<Outline, 'land'>, side: Km): Km[][] {
  return outline.land.map((ring, index) => naturalRing(ring, index, side));
}

function toLonlat(frame: ExerciseFrame, km: Km): [number, number] {
  const point = gridToWgs84(frame, { eastingMetres: km[0] * 1000, northingMetres: km[1] * 1000 });
  return [Math.round(point.longitude * 1e6) / 1e6, Math.round(point.latitude * 1e6) / 1e6];
}

function ring(frame: ExerciseFrame, points: readonly Km[]): [number, number][] {
  return points.map((point) => toLonlat(frame, point));
}

function ellipse(centre: Km, along: number, across: number, degrees: number, steps = 36): Km[] {
  const angle = (degrees * Math.PI) / 180;
  const out: Km[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = (step / steps) * 2 * Math.PI;
    const x = along * Math.cos(t);
    const y = across * Math.sin(t);
    out.push([centre[0] + x * Math.cos(angle) - y * Math.sin(angle), centre[1] + x * Math.sin(angle) + y * Math.cos(angle)]);
  }
  return out;
}

const PLACE_KINDS = new Set(['town', 'port', 'crossing', 'island', 'airfield', 'beach']);

/**
 * The synthetic geography for a scenario in its frame: the hand-drawn outline when the scenario has one, and, for every scenario, its towns, ports and
 * crossings at their grid references, and its routes through theirs. Undefined without a frame.
 */
export function syntheticGeography(scenario: Pick<Scenario, 'id' | 'region'>): Geography | undefined {
  const frame = scenario.region.frame;
  if (!frame) return undefined;
  const outline = SYNTHETIC_OUTLINES[scenario.id];
  const features: GeographyFeature[] = [];
  if (outline) {
    const side: Km = [frame.extent.eastings * frame.squareMetres / 1000, frame.extent.northings * frame.squareMetres / 1000];
    for (const land of naturalLand(outline, side)) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring(frame, land)] }, properties: { kind: 'land' } });
    for (const [index, marshRing] of outline.marsh.entries()) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring(frame, naturalRing(marshRing, 100 + index, side))] }, properties: { kind: 'marsh' } });
    for (const ridge of outline.ridges) {
      ridge.rings.forEach((height, index) => {
        const scale = (ridge.rings.length - index) / ridge.rings.length;
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring(frame, ellipse(ridge.centre, ridge.along * scale, ridge.across * scale, ridge.degrees)) }, properties: { kind: 'contour', height } });
      });
    }
    for (const river of outline.rivers) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring(frame, river.path) }, properties: { kind: 'river', name: river.name } });
  }
  for (const feature of scenario.region.features) {
    const references = gridReferencesIn(feature.location, frame.grid, frame.squareMetres).filter((reference) => reference.precisionMetres <= frame.squareMetres);
    if (!references.length) continue;
    const points = references.map((reference) => {
      const centre = gridCentre(reference);
      return toLonlat(frame, [centre.eastingMetres / 1000, centre.northingMetres / 1000]);
    });
    if (feature.kind === 'route' && points.length >= 2) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: points }, properties: { kind: 'road', name: feature.name } });
    else if (PLACE_KINDS.has(feature.kind)) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: points[0] }, properties: { kind: 'place', name: feature.name } });
  }
  return { type: 'FeatureCollection', features, note: 'Synthetic exercise geography over empty ocean. Nothing on this map is a real place.' };
}
