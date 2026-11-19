// The exercise frame (research note 11, section 6.5; WP-OBS0): how a scenario's fictional grid is placed on the real globe so that feeds in real formats
// (CoT, AIS, GeoJSON) can carry WGS 84 positions without naming any real place. Pure: no I/O, no clock, no vscode.
//
// A frame places the fictional grid over empty ocean near the oceanic pole of inaccessibility, so nothing real is near and no real area of interest is
// revealed. The axis is declared, never guessed: northings grow northward, as on every real grid (owner decision Q4, 2026-11-18: the starter scenario's
// northings were renumbered rather than declaring a southward axis, because a southward axis surprises every reader).
//
// The transform is a local tangent plane: metres east and north of the frame's origin become degrees of longitude and latitude, with the east-west scale
// taken at the frame's centre latitude. For a frame of a few hundred kilometres it is within one percent of true distance, and it is exactly invertible,
// so a position written into a feed reads back to the same grid reference.
import type { ExerciseBox } from '../guardScan';

/** The oceanic pole of inaccessibility, 48°52.6'S 123°23.6'W, 2,688 km from the nearest land (note 11 [F55]). */
export const POINT_NEMO = { latitude: -(48 + 52.6 / 60), longitude: -(123 + 23.6 / 60) } as const;
export const POINT_NEMO_NEAREST_LAND_KM = 2688;
/**
 * The farthest any point of a frame may be from Point Nemo. Every point then has at least 1,688 km of open water to the nearest land, so a frame needs
 * no coastline file to prove it touches no land: the distance alone proves it.
 */
export const FRAME_MAX_FROM_NEMO_KM = 1000;
/** The IUGG mean Earth radius, in metres. */
export const EARTH_RADIUS_M = 6_371_008.8;

/** The one axis a frame may declare. A southward axis is refused: renumber the scenario instead (owner decision Q4). */
export const FRAME_AXES = ['northings-increase-north'] as const;
export type FrameAxis = (typeof FRAME_AXES)[number];
/** The one kind of frame: over empty ocean. A frame over a real training area waits for the v0.6.0 pack builder and a person's decision. */
export const FRAME_KINDS = ['empty-ocean'] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

/** The largest grid square and the largest frame side a frame may declare. */
export const FRAME_MAX_SQUARE_M = 100_000;
export const FRAME_MAX_SIDE_M = 500_000;

export interface LatLon { readonly latitude: number; readonly longitude: number }
/** Metres east and north of the grid's origin (grid easting 0, northing 0). */
export interface GridMetres { readonly eastingMetres: number; readonly northingMetres: number }

export interface ExerciseFrame {
  readonly kind: FrameKind;
  /** The scenario's fictional grid name (`KQ`); a frame applies to that grid only. */
  readonly grid: string;
  /** The side of one square in a four-figure reference (`KQ 4614`), in metres: 1000 for a one-kilometre grid. */
  readonly squareMetres: number;
  /** The WGS 84 position of grid easting 0, northing 0 (the south-west corner of the frame). */
  readonly origin: LatLon;
  /** How many squares the frame spans east and north from the origin. */
  readonly extent: { readonly eastings: number; readonly northings: number };
  readonly axis: FrameAxis;
  /** The magnetic declination the map's margin shows (degrees, east positive). A scenario's value is fictional, like the frame, and its note says so. */
  readonly magneticDeclination?: { readonly degreesEast: number; readonly note: string };
}

/** The closed list of reasons a frame is refused. */
export const FRAME_FAILURES = {
  'wrong-grid': 'The frame must name the scenario\'s own fictional grid.',
  'bad-square': 'The grid square must be a whole number of metres, from 1 to 100,000.',
  'bad-extent': 'The frame must span a whole number of squares each way, at most 500 km a side.',
  'bad-origin': 'The frame origin must be a valid latitude and longitude.',
  'not-ocean': 'The frame must lie wholly over empty ocean, within 1,000 km of the oceanic pole of inaccessibility.'
} as const;
export type FrameFailure = keyof typeof FRAME_FAILURES;

const RAD = Math.PI / 180;

/** Great-circle distance in kilometres (haversine on the mean sphere). */
export function greatCircleKm(a: LatLon, b: LatLon): number {
  const dLat = (b.latitude - a.latitude) * RAD;
  const dLon = (b.longitude - a.longitude) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * RAD) * Math.cos(b.latitude * RAD) * Math.sin(dLon / 2) ** 2;
  return (2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))) / 1000;
}

function sideMetres(frame: ExerciseFrame): { east: number; north: number } {
  return { east: frame.extent.eastings * frame.squareMetres, north: frame.extent.northings * frame.squareMetres };
}

/** The latitude the east-west scale is taken at: the frame's centre. */
function centreLatitude(frame: ExerciseFrame): number {
  return frame.origin.latitude + (sideMetres(frame).north / 2 / EARTH_RADIUS_M) / RAD;
}

/** A grid position (metres east and north of the origin) as WGS 84. */
export function gridToWgs84(frame: ExerciseFrame, point: GridMetres): LatLon {
  const latitude = frame.origin.latitude + (point.northingMetres / EARTH_RADIUS_M) / RAD;
  const longitude = frame.origin.longitude + (point.eastingMetres / (EARTH_RADIUS_M * Math.cos(centreLatitude(frame) * RAD))) / RAD;
  return { latitude, longitude };
}

/** A WGS 84 position as metres east and north of the frame's origin: the exact inverse of gridToWgs84. */
export function wgs84ToGrid(frame: ExerciseFrame, point: LatLon): GridMetres {
  const northingMetres = (point.latitude - frame.origin.latitude) * RAD * EARTH_RADIUS_M;
  const eastingMetres = (point.longitude - frame.origin.longitude) * RAD * EARTH_RADIUS_M * Math.cos(centreLatitude(frame) * RAD);
  return { eastingMetres, northingMetres };
}

/** Whether a grid position lies inside the frame (edges included). */
export function insideFrame(frame: ExerciseFrame, point: GridMetres): boolean {
  const side = sideMetres(frame);
  return point.eastingMetres >= 0 && point.northingMetres >= 0 && point.eastingMetres <= side.east && point.northingMetres <= side.north;
}

/** The frame's outline as a guard-scan exercise box ([longitude, latitude], counter-clockwise from the south-west corner). */
export function frameBox(frame: ExerciseFrame): ExerciseBox {
  const side = sideMetres(frame);
  return ([[0, 0], [side.east, 0], [side.east, side.north], [0, side.north]] as const).map(([e, n]) => {
    const point = gridToWgs84(frame, { eastingMetres: e, northingMetres: n });
    return [point.longitude, point.latitude] as const;
  });
}

/** Why a frame cannot be used, or undefined when it can. `gridName` is the scenario's fictional grid name. */
export function frameProblem(frame: ExerciseFrame, gridName: string): FrameFailure | undefined {
  if (frame.grid !== gridName) return 'wrong-grid';
  if (!Number.isSafeInteger(frame.squareMetres) || frame.squareMetres < 1 || frame.squareMetres > FRAME_MAX_SQUARE_M) return 'bad-square';
  const { eastings, northings } = frame.extent;
  if (!Number.isSafeInteger(eastings) || !Number.isSafeInteger(northings) || eastings < 1 || northings < 1) return 'bad-extent';
  const side = sideMetres(frame);
  if (side.east > FRAME_MAX_SIDE_M || side.north > FRAME_MAX_SIDE_M) return 'bad-extent';
  const { latitude, longitude } = frame.origin;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 89 || Math.abs(longitude) > 180) return 'bad-origin';
  // Corners, edge midpoints and the centre: for a frame this small the farthest point from Nemo is one of them.
  const probes: GridMetres[] = [];
  for (const e of [0, side.east / 2, side.east]) for (const n of [0, side.north / 2, side.north]) probes.push({ eastingMetres: e, northingMetres: n });
  if (probes.some((probe) => greatCircleKm(gridToWgs84(frame, probe), POINT_NEMO) > FRAME_MAX_FROM_NEMO_KM)) return 'not-ocean';
  return undefined;
}

// ---- Grid references ------------------------------------------------------------------------------------------------------------------------

/** A grid reference read from text: the square's south-west corner in metres and the square's side (its precision). */
export interface GridReference extends GridMetres {
  readonly grid: string;
  readonly precisionMetres: number;
}

/**
 * Reads `KQ 4614` (four figures, one square), `KQ 461142` (six figures, a tenth of a square), and so on to ten figures. Half the figures are the easting,
 * half the northing. Undefined for anything else, including a reference on another grid.
 */
export function parseGridReference(text: string, gridName: string, squareMetres: number): GridReference | undefined {
  const match = /^\s*(.+?)\s+(\d+)(?:\s+(\d+))?\s*$/.exec(text);
  if (!match || match[1] !== gridName) return undefined;
  const digits = match[3] === undefined ? match[2] : `${match[2]}${match[3]}`;
  if (match[3] !== undefined && match[2].length !== match[3].length) return undefined;
  if (![4, 6, 8, 10].includes(digits.length)) return undefined;
  const half = digits.length / 2;
  const precisionMetres = squareMetres / 10 ** (half - 2);
  return {
    grid: gridName,
    eastingMetres: Number(digits.slice(0, half)) * precisionMetres,
    northingMetres: Number(digits.slice(half)) * precisionMetres,
    precisionMetres
  };
}

/** Every grid reference on `gridName` written in a line of text, in order (`KQ 4413 to KQ 4613` gives two). */
export function gridReferencesIn(text: string, gridName: string, squareMetres: number): GridReference[] {
  const escaped = gridName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out: GridReference[] = [];
  for (const match of text.matchAll(new RegExp(`(?:^|[^A-Za-z0-9])(${escaped}\\s+\\d{4,10})(?![0-9])`, 'g'))) {
    const reference = parseGridReference(match[1], gridName, squareMetres);
    if (reference) out.push(reference);
  }
  return out;
}

/** The centre of the square a reference names: where a feed places it. */
export function gridCentre(reference: GridReference): GridMetres {
  return { eastingMetres: reference.eastingMetres + reference.precisionMetres / 2, northingMetres: reference.northingMetres + reference.precisionMetres / 2 };
}

/** The circular error of a position read from a grid reference: half the square's diagonal, so the circle holds the whole square. */
export function gridErrorMetres(reference: GridReference): number {
  return (reference.precisionMetres * Math.SQRT2) / 2;
}

/** A grid position as a reference with `figures` figures (4, 6, 8 or 10), truncated to its square as grid references are. */
export function formatGridReference(frame: ExerciseFrame, point: GridMetres, figures: 4 | 6 | 8 | 10 = 4): string {
  const half = figures / 2;
  const precision = frame.squareMetres / 10 ** (half - 2);
  const part = (metres: number): string => String(Math.floor(metres / precision + 1e-9)).padStart(half, '0');
  return `${frame.grid} ${part(point.eastingMetres)}${part(point.northingMetres)}`;
}
