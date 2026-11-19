// The pure half of the pack builder (scripts/build-env-pack.mjs; WP-ENV): turning what GDAL writes into the pack format. Pure: no I/O, no clock,
// no vscode, and no GDAL: the script runs GDAL on a developer machine and passes its text output here.
//
// GDAL does the decoding (GeoTIFF, DTED, GRIB2, NetCDF) and the reprojection to WGS 84, writing each grid as an Esri ASCII grid (AAIGrid), which is
// plain text and easy to read safely; band metadata comes from `gdalinfo -json`. GRIB2 decoding never runs in the extension (note 11, 9.2): the
// extension only reads the finished pack.
import type { Bounds, Dem, WeatherFrameValues, WeatherGrid, WeatherVariable } from './pack';
import { ENV_LIMITS, WEATHER_VARIABLES } from './pack';

export interface AsciiGrid {
  readonly ncols: number;
  readonly nrows: number;
  /** The south-west corner of the south-west cell. */
  readonly xll: number;
  readonly yll: number;
  readonly cellsize: number;
  readonly nodata?: number;
  /** Row by row from north to south: the value at each cell's centre. */
  readonly values: readonly number[];
}

/** Reads an Esri ASCII grid (with square cells, as gdal_translate -of AAIGrid writes for a square -tr), refusing anything malformed or too large. */
export function parseAsciiGrid(text: string, maxCells: number = ENV_LIMITS.demCells): AsciiGrid {
  const lines = text.split(/\r?\n/);
  const header: Record<string, number> = {};
  let index = 0;
  for (; index < lines.length; index += 1) {
    const match = /^\s*([A-Za-z_]+)\s+(\S+)\s*$/.exec(lines[index]);
    if (!match) break;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) throw new Error(`AAIGrid header ${match[1]} is not a number.`);
    header[match[1].toLowerCase()] = value;
  }
  const ncols = header.ncols, nrows = header.nrows;
  const xll = header.xllcorner ?? (header.xllcenter !== undefined ? header.xllcenter - header.cellsize / 2 : undefined);
  const yll = header.yllcorner ?? (header.yllcenter !== undefined ? header.yllcenter - header.cellsize / 2 : undefined);
  if (!Number.isSafeInteger(ncols) || !Number.isSafeInteger(nrows) || ncols < 2 || nrows < 2) throw new Error('AAIGrid needs ncols and nrows of at least 2.');
  if (ncols * nrows > maxCells) throw new Error(`AAIGrid has ${ncols * nrows} cells; at most ${maxCells}.`);
  if (!(header.cellsize > 0) || xll === undefined || yll === undefined) throw new Error('AAIGrid needs square cells (cellsize) and a corner or centre; pass a square -tr to GDAL.');
  const values = lines.slice(index).join(' ').trim().split(/\s+/).filter(Boolean).map(Number);
  if (values.length !== ncols * nrows || !values.every(Number.isFinite)) throw new Error(`AAIGrid holds ${values.length} values; expected ${ncols * nrows}.`);
  return { ncols, nrows, xll, yll, cellsize: header.cellsize, ...(header.nodata_value !== undefined ? { nodata: header.nodata_value } : {}), values };
}

/** The bounds of a grid's cell centres, which is how the pack places its points. */
export function centreBounds(grid: AsciiGrid): Bounds {
  const half = grid.cellsize / 2;
  return [grid.xll + half, grid.yll + half, grid.xll + half + (grid.ncols - 1) * grid.cellsize, grid.yll + half + (grid.nrows - 1) * grid.cellsize];
}

/** A DEM from a GDAL elevation grid: whole metres, no-data kept as the pack's own no-data value. */
export function demFromAsciiGrid(grid: AsciiGrid): Dem {
  const noData = -32768;
  const heights = grid.values.map((value) => (grid.nodata !== undefined && value === grid.nodata ? noData : Math.max(-32767, Math.min(32767, Math.round(value)))));
  return { format: 'near-env-dem', version: 1, bounds: centreBounds(grid), width: grid.ncols, height: grid.nrows, units: 'm', noData, heights };
}

/** Significant wave height in metres to the Douglas sea state (WMO code 3700). */
export function douglasSeaState(metres: number): number {
  const upper = [0, 0.1, 0.5, 1.25, 2.5, 4, 6, 9, 14];
  const state = upper.findIndex((limit) => metres <= limit);
  return state === -1 ? 9 : state;
}

/** A GRIB time as GDAL reports it (`1700000000`, or `  1700000000 sec UTC` in older versions) as an ISO time. */
export function gribTime(value: string): string {
  const match = /^\s*(-?\d{1,12})(?:\s+sec\s+UTC)?\s*$/.exec(value);
  if (!match) throw new Error(`Not a GRIB time: ${value.slice(0, 40)}`);
  return new Date(Number(match[1]) * 1000).toISOString();
}

/** One band GDAL read from a forecast: its GRIB element (UGRD, VGRD, VIS, PRATE, HTSGW), its run and valid times, and its grid. */
export interface ForecastBand { readonly element: string; readonly refTime: string; readonly validTime: string; readonly grid: AsciiGrid }

/** The GRIB elements the builder reads, and what it makes of them. */
export const GRIB_ELEMENTS = ['UGRD', 'VGRD', 'VIS', 'PRATE', 'HTSGW'] as const;

/**
 * A pack's weather grid from forecast bands: wind speed and direction from the U and V components, visibility in km, precipitation in mm an hour
 * and the Douglas sea state from significant wave height. Every band must share one grid and one model run; each valid time becomes a frame.
 */
export function weatherFromBands(model: string, bands: readonly ForecastBand[], stepHours: number): WeatherGrid {
  if (!bands.length) throw new Error('No forecast bands.');
  const grid = bands[0].grid;
  const runs = new Set(bands.map((band) => band.refTime));
  if (runs.size !== 1) throw new Error('Every band must come from one model run.');
  for (const band of bands) {
    if (band.grid.ncols !== grid.ncols || band.grid.nrows !== grid.nrows || band.grid.xll !== grid.xll || band.grid.yll !== grid.yll || band.grid.cellsize !== grid.cellsize) throw new Error('Every band must be warped to the same grid.');
  }
  const times = [...new Set(bands.map((band) => band.validTime))].sort();
  const find = (element: string, time: string) => bands.find((band) => band.element === element && band.validTime === time)?.grid.values;
  const variables = new Set<WeatherVariable>();
  const frames: WeatherFrameValues[] = times.map((time) => {
    const values: Partial<Record<WeatherVariable, number[]>> = {};
    const u = find('UGRD', time), v = find('VGRD', time);
    if (u && v) {
      values['wind-speed'] = u.map((ui, i) => Math.round(Math.hypot(ui, v[i]) * 10) / 10);
      values['wind-from'] = u.map((ui, i) => Math.round(((Math.atan2(-ui, -v[i]) * 180) / Math.PI + 360) % 360));
    }
    const vis = find('VIS', time);
    if (vis) values.visibility = vis.map((m) => Math.round((m / 1000) * 10) / 10);
    const rate = find('PRATE', time);
    if (rate) values.precipitation = rate.map((r) => Math.round(Math.max(0, r * 3600) * 10) / 10);
    const waves = find('HTSGW', time);
    if (waves) values['sea-state'] = waves.map(douglasSeaState);
    for (const key of Object.keys(values) as WeatherVariable[]) variables.add(key);
    return { validAt: time, values };
  });
  // A variable some frames lack would break the format: keep only the variables every frame has.
  const kept = [...variables].filter((id) => frames.every((frame) => frame.values[id] !== undefined));
  if (!kept.length) throw new Error('No usable variable is present at every valid time (need UGRD and VGRD, VIS, PRATE or HTSGW).');
  return {
    format: 'near-env-weather', version: 1, bounds: centreBounds(grid), width: grid.ncols, height: grid.nrows,
    model: { name: model, runAt: [...runs][0] }, stepHours,
    variables: (Object.keys(WEATHER_VARIABLES) as WeatherVariable[]).filter((id) => kept.includes(id)).map((id) => ({ id, units: WEATHER_VARIABLES[id] })),
    frames: frames.map((frame) => ({ validAt: frame.validAt, values: Object.fromEntries(kept.map((id) => [id, frame.values[id]!])) }))
  };
}
