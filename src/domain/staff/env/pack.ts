// Environment packs (research note 11, 4.7, 6.1, 6.4 and 9.2 item 4; WP-ENV): the offline terrain and weather the COP map draws, as a small folder
// of JSON files. Pure: no I/O, no clock, no vscode. The format is documented in docs/staff-env-packs.md, and resources/staff/env/env-pack.schema.json
// is its JSON Schema; a test holds this validator and the schema together.
//
// A pack is a folder:
//   manifest.json     what the pack is: version, bounding box, whether the data is synthetic or real, attribution and licence, and every file's hash
//   dem.json          a digital elevation model: heights in metres on a regular latitude and longitude grid
//   coastline.geojson the land outline (polygons) and coastline (lines)
//   weather.json      an optional forecast grid: the model, its run time, and one frame of values per valid time
//
// Validation on load refuses a pack, never repairs it: a manifest or file that breaks the format, a file whose bytes do not match the hash the
// manifest records, any coordinate outside the exercise frame (for a pack drawn in a frame), and a real-data pack without its attribution and the
// licence of every source. The bounding box is the only place a DEM or weather grid has coordinates, so a grid inside the box is inside the frame.
import { createHash } from 'node:crypto';
import { gridToWgs84, insideFrame, wgs84ToGrid } from '../obs/frame';
import type { ExerciseFrame } from '../obs/frame';

export const ENV_PACK_FORMAT = 'near-env-pack';
export const ENV_DEM_FORMAT = 'near-env-dem';
export const ENV_WEATHER_FORMAT = 'near-env-weather';
export const ENV_PACK_VERSION = 1;
/** The file names of a pack, by role. A manifest may name only these, so a manifest can never point outside its own folder. */
export const ENV_FILES = { dem: 'dem.json', coastline: 'coastline.geojson', weather: 'weather.json' } as const;
export type EnvFileRole = keyof typeof ENV_FILES;
export const ENV_MANIFEST = 'manifest.json';

/** Caps, so a hostile or mistaken pack cannot exhaust the extension host. */
export const ENV_LIMITS = {
  /** The largest file the loader reads, in bytes. */
  fileBytes: 8 * 1024 * 1024,
  demSide: 2049,
  demCells: 1_000_000,
  weatherSide: 201,
  weatherCells: 10_000,
  weatherFrames: 200,
  coastlineFeatures: 5000,
  coastlinePoints: 200_000,
  textLength: 300,
  attributions: 20,
  sources: 20
} as const;

/** The weather variables a pack may carry, with the one unit each must be in. */
export const WEATHER_VARIABLES = {
  'wind-speed': 'm/s',
  'wind-from': 'degrees',
  'sea-state': 'douglas',
  visibility: 'km',
  precipitation: 'mm/h'
} as const;
export type WeatherVariable = keyof typeof WEATHER_VARIABLES;

export type Bounds = readonly [west: number, south: number, east: number, north: number];

export interface EnvFileEntry { readonly path: string; readonly sha256: string; readonly bytes: number }

export interface EnvSource { readonly name: string; readonly licence: string; readonly url?: string }

export interface EnvManifest {
  readonly format: typeof ENV_PACK_FORMAT;
  readonly version: typeof ENV_PACK_VERSION;
  readonly id: string;
  readonly title: string;
  /** Synthetic (generated, nothing real) or real (built from a real DEM or forecast on a developer machine). */
  readonly data: 'synthetic' | 'real';
  readonly crs: 'EPSG:4326';
  /** West, south, east, north in degrees; every file's coordinates lie inside it. */
  readonly bounds: Bounds;
  /** The scenario and grid a synthetic pack was generated for. */
  readonly frame?: { readonly scenario: string; readonly grid: string };
  /** How a synthetic pack was made: the script and the seed, so anyone can make it again byte for byte. */
  readonly generator?: { readonly script: string; readonly seed: number; readonly version: number };
  /** Words shown on the map with the layers. Required, and at least one, for real data. */
  readonly attribution: readonly string[];
  readonly licence: string;
  /** Where real data came from, each with its licence. Required, and at least one, for real data. */
  readonly sources?: readonly EnvSource[];
  readonly files: { readonly dem: EnvFileEntry; readonly coastline: EnvFileEntry; readonly weather?: EnvFileEntry };
}

export interface Dem {
  readonly format: typeof ENV_DEM_FORMAT;
  readonly version: typeof ENV_PACK_VERSION;
  /** The grid's outer points: the first height is at (west, north), the last at (east, south). */
  readonly bounds: Bounds;
  readonly width: number;
  readonly height: number;
  readonly units: 'm';
  /** A height no real point has, for points without data. */
  readonly noData: number;
  /** Row by row from north to south, each row west to east: width x height whole metres. */
  readonly heights: readonly number[];
}

export interface WeatherFrameValues { readonly validAt: string; readonly values: Readonly<Partial<Record<WeatherVariable, readonly number[]>>> }

export interface WeatherGrid {
  readonly format: typeof ENV_WEATHER_FORMAT;
  readonly version: typeof ENV_PACK_VERSION;
  readonly bounds: Bounds;
  readonly width: number;
  readonly height: number;
  /** The forecast model and the time of its run: a snapshot, so the map shows its age and a stale forecast never looks current. */
  readonly model: { readonly name: string; readonly runAt: string };
  /** Hours each frame stays valid after its valid time (the step between frames). */
  readonly stepHours: number;
  readonly variables: ReadonlyArray<{ readonly id: WeatherVariable; readonly units: string }>;
  readonly frames: readonly WeatherFrameValues[];
}

export interface CoastlineFeature {
  readonly type: 'Feature';
  readonly geometry: { readonly type: 'Polygon'; readonly coordinates: readonly (readonly (readonly [number, number])[])[] } | { readonly type: 'LineString'; readonly coordinates: readonly (readonly [number, number])[] };
  readonly properties: { readonly kind: 'land' | 'coastline'; readonly name?: string };
}
export interface Coastline { readonly type: 'FeatureCollection'; readonly features: readonly CoastlineFeature[] }

export interface EnvPack {
  readonly manifest: EnvManifest;
  readonly dem: Dem;
  readonly coastline: Coastline;
  readonly weather?: WeatherGrid;
}

export type PackResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly string[] };

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---- Shape checks (the same rules as env-pack.schema.json) -----------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number = ENV_LIMITS.textLength): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
const isIso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) && !Number.isNaN(Date.parse(value));
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function onlyKeys(value: Json, allowed: readonly string[], where: string, problems: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${where}: unknown field "${key.slice(0, 40)}".`);
}

function checkBounds(value: unknown, where: string, problems: string[]): value is Bounds {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    problems.push(`${where}: bounds must be [west, south, east, north] in degrees.`);
    return false;
  }
  const [w, s, e, n] = value as number[];
  if (w < -180 || e > 180 || s < -90 || n > 90 || !(w < e) || !(s < n)) { problems.push(`${where}: bounds must have west < east and south < north, within the globe.`); return false; }
  return true;
}

function checkEntry(value: unknown, role: EnvFileRole, problems: string[]): void {
  const where = `manifest files.${role}`;
  if (!isObject(value)) { problems.push(`${where}: missing.`); return; }
  onlyKeys(value, ['path', 'sha256', 'bytes'], where, problems);
  if (value.path !== ENV_FILES[role]) problems.push(`${where}: path must be "${ENV_FILES[role]}".`);
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) problems.push(`${where}: sha256 must be 64 lowercase hex characters.`);
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 1 || (value.bytes as number) > ENV_LIMITS.fileBytes) problems.push(`${where}: bytes must be a whole number from 1 to ${ENV_LIMITS.fileBytes}.`);
}

/** Checks a manifest's shape and the attribution rule; the files are checked separately. */
export function checkManifest(value: unknown): PackResult<EnvManifest> {
  const problems: string[] = [];
  if (!isObject(value)) return { ok: false, problems: ['manifest: not a JSON object.'] };
  onlyKeys(value, ['format', 'version', 'id', 'title', 'data', 'crs', 'bounds', 'frame', 'generator', 'attribution', 'licence', 'sources', 'files'], 'manifest', problems);
  if (value.format !== ENV_PACK_FORMAT) problems.push(`manifest: format must be "${ENV_PACK_FORMAT}".`);
  if (value.version !== ENV_PACK_VERSION) problems.push(`manifest: version ${String(value.version).slice(0, 20)} is not supported (this build reads version ${ENV_PACK_VERSION}).`);
  if (typeof value.id !== 'string' || !ID.test(value.id)) problems.push('manifest: id must be lowercase letters, digits and hyphens.');
  if (!isText(value.title)) problems.push('manifest: title is required.');
  if (value.data !== 'synthetic' && value.data !== 'real') problems.push('manifest: data must be "synthetic" or "real".');
  if (value.crs !== 'EPSG:4326') problems.push('manifest: crs must be "EPSG:4326" (WGS 84 latitude and longitude).');
  checkBounds(value.bounds, 'manifest', problems);
  if (value.frame !== undefined) {
    if (!isObject(value.frame) || typeof value.frame.scenario !== 'string' || !ID.test(value.frame.scenario) || !isText(value.frame.grid, 20)) problems.push('manifest: frame must name a scenario id and its grid.');
    else onlyKeys(value.frame, ['scenario', 'grid'], 'manifest frame', problems);
  }
  if (value.generator !== undefined) {
    const g = value.generator;
    if (!isObject(g) || !isText(g.script, 200) || !Number.isSafeInteger(g.seed) || !Number.isSafeInteger(g.version)) problems.push('manifest: generator must name its script, a whole-number seed and a version.');
    else onlyKeys(g, ['script', 'seed', 'version'], 'manifest generator', problems);
  }
  const attribution = value.attribution;
  if (!Array.isArray(attribution) || attribution.length > ENV_LIMITS.attributions || !attribution.every((line) => isText(line))) problems.push('manifest: attribution must be a list of short lines.');
  if (!isText(value.licence)) problems.push('manifest: licence is required.');
  const sources = value.sources;
  if (sources !== undefined) {
    if (!Array.isArray(sources) || sources.length > ENV_LIMITS.sources) problems.push('manifest: sources must be a list.');
    else sources.forEach((source, index) => {
      if (!isObject(source) || !isText(source.name) || !isText(source.licence) || (source.url !== undefined && !isText(source.url))) problems.push(`manifest sources[${index}]: a source needs a name and a licence.`);
      else onlyKeys(source, ['name', 'licence', 'url'], `manifest sources[${index}]`, problems);
    });
  }
  if (value.data === 'real') {
    // Real data: the attribution its licence requires is shown on the map, and every source says its licence (note 11, 10: ODbL and similar).
    if (!Array.isArray(attribution) || attribution.length === 0) problems.push('manifest: a real-data pack must carry the attribution its sources require.');
    if (!Array.isArray(sources) || sources.length === 0) problems.push('manifest: a real-data pack must list its sources and their licences.');
    if (value.generator !== undefined) problems.push('manifest: a real-data pack has no generator; generated data is "synthetic".');
  }
  if (value.data === 'synthetic' && value.generator === undefined) problems.push('manifest: a synthetic pack must name its generator and seed.');
  if (!isObject(value.files)) problems.push('manifest: files is required.');
  else {
    onlyKeys(value.files, ['dem', 'coastline', 'weather'], 'manifest files', problems);
    checkEntry(value.files.dem, 'dem', problems);
    checkEntry(value.files.coastline, 'coastline', problems);
    if (value.files.weather !== undefined) checkEntry(value.files.weather, 'weather', problems);
  }
  return problems.length ? { ok: false, problems } : { ok: true, value: value as unknown as EnvManifest };
}

export function checkDem(value: unknown): PackResult<Dem> {
  const problems: string[] = [];
  if (!isObject(value)) return { ok: false, problems: ['dem: not a JSON object.'] };
  onlyKeys(value, ['format', 'version', 'bounds', 'width', 'height', 'units', 'noData', 'heights'], 'dem', problems);
  if (value.format !== ENV_DEM_FORMAT) problems.push(`dem: format must be "${ENV_DEM_FORMAT}".`);
  if (value.version !== ENV_PACK_VERSION) problems.push('dem: unsupported version.');
  checkBounds(value.bounds, 'dem', problems);
  if (value.units !== 'm') problems.push('dem: units must be "m".');
  if (!Number.isSafeInteger(value.noData)) problems.push('dem: noData must be a whole number.');
  const { width, height } = value;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 2 || (height as number) < 2 || (width as number) > ENV_LIMITS.demSide || (height as number) > ENV_LIMITS.demSide || (width as number) * (height as number) > ENV_LIMITS.demCells) {
    problems.push(`dem: width and height must be whole numbers from 2 to ${ENV_LIMITS.demSide}, at most ${ENV_LIMITS.demCells.toLocaleString('en-US')} points.`);
  } else if (!Array.isArray(value.heights) || value.heights.length !== (width as number) * (height as number)) problems.push('dem: heights must hold width x height values.');
  else if (!value.heights.every((h) => Number.isSafeInteger(h) && Math.abs(h as number) <= 32768)) problems.push('dem: every height must be a whole number of metres within +/-32768.');
  return problems.length ? { ok: false, problems } : { ok: true, value: value as unknown as Dem };
}

export function checkWeather(value: unknown): PackResult<WeatherGrid> {
  const problems: string[] = [];
  if (!isObject(value)) return { ok: false, problems: ['weather: not a JSON object.'] };
  onlyKeys(value, ['format', 'version', 'bounds', 'width', 'height', 'model', 'stepHours', 'variables', 'frames'], 'weather', problems);
  if (value.format !== ENV_WEATHER_FORMAT) problems.push(`weather: format must be "${ENV_WEATHER_FORMAT}".`);
  if (value.version !== ENV_PACK_VERSION) problems.push('weather: unsupported version.');
  checkBounds(value.bounds, 'weather', problems);
  const { width, height } = value;
  const sized = Number.isSafeInteger(width) && Number.isSafeInteger(height) && (width as number) >= 2 && (height as number) >= 2 && (width as number) <= ENV_LIMITS.weatherSide && (height as number) <= ENV_LIMITS.weatherSide && (width as number) * (height as number) <= ENV_LIMITS.weatherCells;
  if (!sized) problems.push(`weather: width and height must be whole numbers from 2 to ${ENV_LIMITS.weatherSide}, at most ${ENV_LIMITS.weatherCells} points.`);
  if (!isObject(value.model) || !isText(value.model.name) || !isIso(value.model.runAt)) problems.push('weather: model must name the model and its run time (ISO 8601, UTC).');
  if (typeof value.stepHours !== 'number' || !(value.stepHours > 0) || value.stepHours > 48) problems.push('weather: stepHours must be more than 0 and at most 48.');
  const declared: WeatherVariable[] = [];
  if (!Array.isArray(value.variables) || value.variables.length === 0) problems.push('weather: variables must list at least one variable.');
  else for (const variable of value.variables) {
    const id = isObject(variable) ? variable.id : undefined;
    if (typeof id !== 'string' || !(id in WEATHER_VARIABLES)) { problems.push(`weather: unknown variable ${JSON.stringify(id)?.slice(0, 40)}.`); continue; }
    if (variable.units !== WEATHER_VARIABLES[id as WeatherVariable]) problems.push(`weather: ${id} must be in ${WEATHER_VARIABLES[id as WeatherVariable]}.`);
    if (declared.includes(id as WeatherVariable)) problems.push(`weather: ${id} is listed twice.`);
    declared.push(id as WeatherVariable);
  }
  if (!Array.isArray(value.frames) || value.frames.length === 0 || value.frames.length > ENV_LIMITS.weatherFrames) problems.push(`weather: frames must hold 1 to ${ENV_LIMITS.weatherFrames} frames.`);
  else if (sized) {
    const cells = (width as number) * (height as number);
    let previous = -Infinity;
    value.frames.forEach((frame, index) => {
      if (!isObject(frame) || !isIso(frame.validAt) || !isObject(frame.values)) { problems.push(`weather frames[${index}]: needs a validAt time and values.`); return; }
      const at = Date.parse(frame.validAt);
      if (!(at > previous)) problems.push(`weather frames[${index}]: valid times must strictly increase.`);
      previous = at;
      for (const key of Object.keys(frame.values)) if (!declared.includes(key as WeatherVariable)) problems.push(`weather frames[${index}]: ${key.slice(0, 40)} is not a declared variable.`);
      for (const id of declared) {
        const values = (frame.values as Json)[id];
        if (!Array.isArray(values) || values.length !== cells || !values.every((n) => typeof n === 'number' && Number.isFinite(n))) problems.push(`weather frames[${index}]: ${id} must hold width x height numbers.`);
      }
    });
  }
  return problems.length ? { ok: false, problems } : { ok: true, value: value as unknown as WeatherGrid };
}

export function checkCoastline(value: unknown): PackResult<Coastline> {
  const problems: string[] = [];
  if (!isObject(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) return { ok: false, problems: ['coastline: must be a GeoJSON FeatureCollection.'] };
  if (value.features.length > ENV_LIMITS.coastlineFeatures) return { ok: false, problems: [`coastline: at most ${ENV_LIMITS.coastlineFeatures} features.`] };
  let points = 0;
  const position = (c: unknown) => Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === 'number' && Number.isFinite(n));
  value.features.forEach((feature, index) => {
    const where = `coastline features[${index}]`;
    if (!isObject(feature) || feature.type !== 'Feature' || !isObject(feature.geometry) || !isObject(feature.properties)) { problems.push(`${where}: not a GeoJSON feature.`); return; }
    const kind = feature.properties.kind;
    const g = feature.geometry;
    if (kind === 'land' && g.type === 'Polygon') {
      const rings = g.coordinates;
      if (!Array.isArray(rings) || rings.length === 0 || !rings.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(position))) problems.push(`${where}: a land polygon needs closed rings of [longitude, latitude].`);
      else points += rings.reduce((sum, ring) => sum + (ring as unknown[]).length, 0);
    } else if (kind === 'coastline' && g.type === 'LineString') {
      if (!Array.isArray(g.coordinates) || g.coordinates.length < 2 || !g.coordinates.every(position)) problems.push(`${where}: a coastline needs at least two [longitude, latitude] points.`);
      else points += g.coordinates.length;
    } else problems.push(`${where}: kind must be "land" (Polygon) or "coastline" (LineString).`);
    if (feature.properties.name !== undefined && !isText(feature.properties.name, 80)) problems.push(`${where}: name must be short text.`);
  });
  if (points > ENV_LIMITS.coastlinePoints) problems.push(`coastline: at most ${ENV_LIMITS.coastlinePoints.toLocaleString('en-US')} points.`);
  return problems.length ? { ok: false, problems } : { ok: true, value: value as unknown as Coastline };
}

// ---- Coordinates --------------------------------------------------------------------------------------------------------------------------------

/** Every [longitude, latitude] a pack names: its corners (the grids have no other coordinates) and every coastline point. */
export function packCoordinates(pack: EnvPack): Array<readonly [number, number]> {
  const corners = (b: Bounds) => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]] as const;
  const out: Array<readonly [number, number]> = [...corners(pack.manifest.bounds), ...corners(pack.dem.bounds)];
  if (pack.weather) out.push(...corners(pack.weather.bounds));
  for (const feature of pack.coastline.features) {
    const g = feature.geometry;
    if (g.type === 'Polygon') for (const ring of g.coordinates) out.push(...ring);
    else out.push(...g.coordinates);
  }
  return out;
}

/** Inside the bounds, with a millimetre-scale allowance for the last decimal of a rounded degree. */
function insideBounds(b: Bounds, [lon, lat]: readonly [number, number]): boolean {
  const e = 1e-9;
  return lon >= b[0] - e && lon <= b[2] + e && lat >= b[1] - e && lat <= b[3] + e;
}

/** The frame's outer box in degrees (south-west and north-east corners). */
export function frameBounds(frame: ExerciseFrame): Bounds {
  const sw = gridToWgs84(frame, { eastingMetres: 0, northingMetres: 0 });
  const ne = gridToWgs84(frame, { eastingMetres: frame.extent.eastings * frame.squareMetres, northingMetres: frame.extent.northings * frame.squareMetres });
  return [sw.longitude, sw.latitude, ne.longitude, ne.latitude];
}

/** The coordinates of a pack outside a frame (at most `limit` of them, for the message). */
export function outsideFrame(pack: EnvPack, frame: ExerciseFrame, limit = 3): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  // One centimetre, for float noise in the inverse transform only; never a real offset.
  const allowance = 0.01;
  const side = { east: frame.extent.eastings * frame.squareMetres, north: frame.extent.northings * frame.squareMetres };
  const snap = (metres: number, max: number) => (metres < 0 && metres > -allowance ? 0 : metres > max && metres < max + allowance ? max : metres);
  for (const point of packCoordinates(pack)) {
    const grid = wgs84ToGrid(frame, { longitude: point[0], latitude: point[1] });
    if (!insideFrame(frame, { eastingMetres: snap(grid.eastingMetres, side.east), northingMetres: snap(grid.northingMetres, side.north) })) { out.push(point); if (out.length >= limit) break; }
  }
  return out;
}

// ---- The whole pack -----------------------------------------------------------------------------------------------------------------------------

export interface PackFiles {
  /** The bytes of each file the folder holds, by file name. Files the manifest does not name are ignored and never read further. */
  readonly [name: string]: Uint8Array | undefined;
}

export interface PackCheckOptions {
  /** The frame the pack is drawn in: every coordinate must lie inside it, and a synthetic pack must have been made for its grid. */
  readonly frame?: ExerciseFrame;
  /** The scenario the frame belongs to: a synthetic pack must have been made for it. */
  readonly scenario?: string;
}

function parseJson(bytes: Uint8Array, name: string, problems: string[]): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { problems.push(`${name}: not valid UTF-8 JSON.`); return undefined; }
}

/**
 * Validates a pack from its files' bytes: the manifest's shape and attribution rule, each named file's size and SHA-256 against the manifest, each
 * file's shape, every coordinate inside the manifest's bounds, and, with a frame, every coordinate inside the frame. Returns every problem found.
 */
export function readEnvPack(files: PackFiles, options: PackCheckOptions = {}): PackResult<EnvPack> {
  const problems: string[] = [];
  const manifestBytes = files[ENV_MANIFEST];
  if (!manifestBytes) return { ok: false, problems: ['manifest.json is missing.'] };
  if (manifestBytes.length > ENV_LIMITS.fileBytes) return { ok: false, problems: ['manifest.json is too large.'] };
  const manifestJson = parseJson(manifestBytes, ENV_MANIFEST, problems);
  if (manifestJson === undefined) return { ok: false, problems };
  const manifest = checkManifest(manifestJson);
  if (!manifest.ok) return manifest;
  const m = manifest.value;
  const parsed: Partial<Record<EnvFileRole, unknown>> = {};
  for (const role of Object.keys(ENV_FILES) as EnvFileRole[]) {
    const entry = m.files[role];
    if (!entry) continue;
    const bytes = files[entry.path];
    if (!bytes) { problems.push(`${entry.path} is missing.`); continue; }
    if (bytes.length !== entry.bytes) { problems.push(`${entry.path}: ${bytes.length} bytes, but the manifest records ${entry.bytes}.`); continue; }
    if (sha256Hex(bytes) !== entry.sha256) { problems.push(`${entry.path}: its SHA-256 does not match the manifest; the file was changed after the pack was made.`); continue; }
    parsed[role] = parseJson(bytes, entry.path, problems);
  }
  if (problems.length) return { ok: false, problems };
  const dem = checkDem(parsed.dem);
  const coastline = checkCoastline(parsed.coastline);
  const weather = m.files.weather ? checkWeather(parsed.weather) : undefined;
  for (const result of [dem, coastline, weather]) if (result && !result.ok) problems.push(...result.problems);
  if (problems.length || !dem.ok || !coastline.ok || (weather && !weather.ok)) return { ok: false, problems };
  const pack: EnvPack = { manifest: m, dem: dem.value, coastline: coastline.value, ...(weather && weather.ok ? { weather: weather.value } : {}) };
  const strays = packCoordinates(pack).filter((point) => !insideBounds(m.bounds, point));
  if (strays.length) problems.push(`${strays.length} coordinate${strays.length === 1 ? '' : 's'} lie outside the manifest's bounding box, for example ${strays[0].join(', ')}.`);
  if (options.frame) {
    if (m.data === 'synthetic' && (m.frame?.grid !== options.frame.grid || (options.scenario !== undefined && m.frame?.scenario !== options.scenario))) problems.push('This synthetic pack was made for another scenario or grid.');
    const outside = outsideFrame(pack, options.frame);
    if (outside.length) problems.push(`The pack has coordinates outside the exercise frame, for example ${outside[0].join(', ')}; a pack drawn in a frame must lie wholly inside it.`);
  }
  return problems.length ? { ok: false, problems } : { ok: true, value: pack };
}

/** The manifest entry for a file's bytes. */
export function fileEntry(role: EnvFileRole, bytes: Uint8Array | string): EnvFileEntry {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return { path: ENV_FILES[role], sha256: sha256Hex(data), bytes: data.length };
}

/**
 * Writes a pack's files as text, in a fixed key order, and the manifest that records their hashes. The generator and the pack builder both use it,
 * so a synthetic and a real pack are the same format byte for byte.
 */
export function writeEnvPack(input: Omit<EnvManifest, 'format' | 'version' | 'crs' | 'files'> & { readonly dem: Dem; readonly coastline: Coastline; readonly weather?: WeatherGrid }): Record<string, string> {
  const demText = `{"format":${JSON.stringify(ENV_DEM_FORMAT)},"version":${ENV_PACK_VERSION},"bounds":${JSON.stringify(input.dem.bounds)},"width":${input.dem.width},"height":${input.dem.height},"units":"m","noData":${input.dem.noData},"heights":[\n${rows(input.dem.heights, input.dem.width)}\n]}\n`;
  const coastText = `{"type":"FeatureCollection","features":[\n${input.coastline.features.map((feature) => JSON.stringify({ type: 'Feature', properties: feature.properties, geometry: feature.geometry })).join(',\n')}\n]}\n`;
  let weatherText: string | undefined;
  if (input.weather) {
    const w = input.weather;
    const frames = w.frames.map((frame) => `{"validAt":${JSON.stringify(frame.validAt)},"values":{${w.variables.map((variable) => `${JSON.stringify(variable.id)}:[${(frame.values[variable.id] ?? []).join(',')}]`).join(',')}}}`);
    weatherText = `{"format":${JSON.stringify(ENV_WEATHER_FORMAT)},"version":${ENV_PACK_VERSION},"bounds":${JSON.stringify(w.bounds)},"width":${w.width},"height":${w.height},"model":${JSON.stringify({ name: w.model.name, runAt: w.model.runAt })},"stepHours":${w.stepHours},"variables":${JSON.stringify(w.variables.map((v) => ({ id: v.id, units: v.units })))},"frames":[\n${frames.join(',\n')}\n]}\n`;
  }
  const manifest: EnvManifest = {
    format: ENV_PACK_FORMAT, version: ENV_PACK_VERSION, id: input.id, title: input.title, data: input.data, crs: 'EPSG:4326', bounds: input.bounds,
    ...(input.frame ? { frame: { scenario: input.frame.scenario, grid: input.frame.grid } } : {}),
    ...(input.generator ? { generator: { script: input.generator.script, seed: input.generator.seed, version: input.generator.version } } : {}),
    attribution: [...input.attribution], licence: input.licence, ...(input.sources ? { sources: input.sources.map((s) => ({ name: s.name, licence: s.licence, ...(s.url ? { url: s.url } : {}) })) } : {}),
    files: { dem: fileEntry('dem', demText), coastline: fileEntry('coastline', coastText), ...(weatherText ? { weather: fileEntry('weather', weatherText) } : {}) }
  };
  return { [ENV_MANIFEST]: `${JSON.stringify(manifest, null, 2)}\n`, [ENV_FILES.dem]: demText, [ENV_FILES.coastline]: coastText, ...(weatherText ? { [ENV_FILES.weather]: weatherText } : {}) };
}

function rows(values: readonly number[], width: number): string {
  const out: string[] = [];
  for (let start = 0; start < values.length; start += width) out.push(values.slice(start, start + width).join(','));
  return out.join(',\n');
}
