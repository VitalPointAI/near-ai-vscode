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

interface Outline {
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
      [[28, 45.5], [46, 45.5], [47.5, 47], [47, 56], [28, 56], [28, 45.5]],
      // Gull Island, in the western mouth of the strait.
      [[40.6, 41.6], [41.5, 41.7], [41.6, 42.5], [40.8, 42.6], [40.6, 41.6]]
    ],
    marsh: [[[42, 25.6], [44.4, 25.6], [44.4, 26.9], [42, 27], [42, 25.6]]],
    rivers: [{ name: 'River Brenn', path: [[47.5, 29], [46.5, 28.6], [45.5, 28.5], [44.5, 27.8], [43, 27.4], [41.8, 27.4]] }],
    ridges: [{ centre: [48, 29], along: 4, across: 1.8, degrees: 72, rings: [100, 200, 300] }]
  }
};

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
    for (const land of outline.land) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring(frame, land)] }, properties: { kind: 'land' } });
    for (const marsh of outline.marsh) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring(frame, marsh)] }, properties: { kind: 'marsh' } });
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
