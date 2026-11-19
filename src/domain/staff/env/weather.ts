// The weather layer from a pack's forecast grid (research note 11, 4.7 and 6.1; WP-ENV). Pure: no I/O, no clock, no vscode.
//
// A pack's forecast is a snapshot: one model run, one frame per valid time. Each frame holds from its valid time until the next frame's (the last for
// `stepHours`). The shared time slider picks the frame: in "as happened" mode, the frame valid at the clock time; in "as known" mode, the same frame
// but only once the model run that made it had happened, because the staff could not have known a forecast before it was run. Outside every frame
// there is no weather, and the map says so: a forecast is never stretched past the times it covers. The page (media/staff/copMap.js weatherFrameAt)
// applies the same rule; a test holds the two together.
//
// The map draws each frame as wind arrows (pointing where the wind blows to, longer for stronger wind), fog cells (visibility under 1 km), rain cells
// (at least 0.5 mm an hour) and rough-sea cells (sea state 4 or more, when landing craft cannot use a beach). The frame's words (valid time, model run
// and lead time) go in the map's status line. The layer is sent compactly: the grid points once, then per frame the wind at each point and the list of
// marked cells, and the page builds the shapes (media/staff/copMap.js weatherFeatures), so fourteen frames stay a few tens of kilobytes.
import type { Position } from './terrain';
import { gridToLonLat } from './terrain';
import type { Bounds, WeatherGrid } from './pack';

/** Fog: visibility under this many kilometres. */
export const FOG_VISIBILITY_KM = 1;
/** Rain worth drawing: at least this many millimetres an hour. */
export const RAIN_MM_PER_HOUR = 0.5;
/** Rough sea: Douglas sea state 4 (moderate) or more. */
export const ROUGH_SEA_STATE = 4;

export type WeatherCellKind = 'fog' | 'rain' | 'rough-sea';

export interface WeatherFrame {
  /** Epoch milliseconds: the frame holds from validFrom (its valid time) until validTo. */
  readonly validFrom: number;
  readonly validTo: number;
  /** The frame in words: its valid time, the run and the lead time. */
  readonly label: string;
  /** Wind speed (m/s) and the direction it blows from (degrees), one pair per grid point, flattened; absent when the pack has no wind. */
  readonly wind?: readonly number[];
  /** Marked cells: [grid point index, kind, opacity]. */
  readonly cells: ReadonlyArray<readonly [number, WeatherCellKind, number]>;
}

export interface WeatherLayer {
  readonly model: string;
  /** Epoch milliseconds of the model run. */
  readonly runAt: number;
  readonly bounds: Bounds;
  /** The grid points, [longitude, latitude], row by row from the north. */
  readonly points: readonly Position[];
  /** The size of one grid cell in degrees: [longitude, latitude]. */
  readonly cell: readonly [number, number];
  readonly frames: readonly WeatherFrame[];
}

/** The frame the map shows at time t: valid at t and, in "as known" mode, from a run already made by t. Undefined outside every frame. */
export function weatherFrameAt<F extends { readonly validFrom: number; readonly validTo: number }>(layer: { readonly runAt: number; readonly frames: readonly F[] }, t: number, mode: 'valid' | 'known'): F | undefined {
  if (mode === 'known' && t < layer.runAt) return undefined;
  return layer.frames.find((frame) => frame.validFrom <= t && t < frame.validTo);
}

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

/** The weather layer for the map. */
export function weatherLayer(grid: WeatherGrid): WeatherLayer {
  const runAt = Date.parse(grid.model.runAt);
  const { width, height, bounds } = grid;
  const points: Position[] = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) points.push(gridToLonLat(bounds, width, height, [x, y]));
  const cell: [number, number] = [(bounds[2] - bounds[0]) / (width - 1), (bounds[3] - bounds[1]) / (height - 1)];
  const two = (value: number) => Math.round(value * 100) / 100;
  const frames = grid.frames.map((frame, index): WeatherFrame => {
    const validFrom = Date.parse(frame.validAt);
    const next = grid.frames[index + 1];
    const validTo = next ? Date.parse(next.validAt) : validFrom + grid.stepHours * 3_600_000;
    const lead = Math.round((validFrom - runAt) / 3_600_000);
    const v = frame.values;
    const cells: Array<[number, WeatherCellKind, number]> = [];
    for (let i = 0; i < points.length; i += 1) {
      const visibility = v.visibility?.[i];
      const rain = v.precipitation?.[i];
      const sea = v['sea-state']?.[i];
      if (visibility !== undefined && visibility < FOG_VISIBILITY_KM) cells.push([i, 'fog', 0.35]);
      if (rain !== undefined && rain >= RAIN_MM_PER_HOUR) cells.push([i, 'rain', two(Math.min(0.5, 0.12 + rain / 20))]);
      if (sea !== undefined && sea >= ROUGH_SEA_STATE) cells.push([i, 'rough-sea', two(Math.min(0.5, 0.15 + (sea - ROUGH_SEA_STATE) * 0.1))]);
    }
    const speed = v['wind-speed'];
    const from = v['wind-from'];
    const wind = speed && from ? speed.flatMap((s, i) => [Math.round(s * 10) / 10, Math.round(from[i])]) : undefined;
    return { validFrom, validTo, label: `Weather valid ${hhmm(validFrom)} to ${hhmm(validTo)}, ${grid.model.name} run ${hhmm(runAt)} (+${lead} h)`, ...(wind ? { wind } : {}), cells };
  });
  return { model: grid.model.name, runAt, bounds, points, cell, frames };
}
