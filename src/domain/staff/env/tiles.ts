// Map tiles (research note "COP map: photo-realistic imagery, 3D globe, 3D terrain and topographic base"): the Web Mercator tile maths, the
// Terrarium height encoding MapLibre decodes for 3D terrain and hillshade, and the tile index every bundled tile folder carries. Pure: no I/O, no
// clock, no vscode.
//
// Bundled tiles are plain {z}/{x}/{y} files the page loads from the extension (never a PMTiles archive: older VS Code webviews mishandle range
// requests). Each tile folder has one index.json listing every tile with its size, its SHA-256 and a digest of its pixels before encoding. The host
// checks a folder against its index before it gives the page any tile address (src/staff/mapTiles.ts), and refuses the whole folder on any problem:
// a path that could leave the folder, a tile outside its set's zoom range or bounds, a file over the size cap, a file whose first bytes are not the
// format it claims, or bytes that do not match the index.
//
// The pixel digest exists because two builds of the same encoder may write different bytes for the same pixels; a regeneration check compares
// pixels, while the file hash keeps every shipped byte checked.
import { createHash } from 'node:crypto';
import type { Bounds } from './pack';

export const TILE_INDEX_FORMAT = 'near-map-tiles';
export const TILE_INDEX_VERSION = 1;
export const TILE_INDEX_FILE = 'index.json';
export const TILE_SIZE = 256;
/** The Web Mercator latitude limit. */
export const MERCATOR_MAX_LAT = 85.051129;

export const TILE_LIMITS = {
  /** The largest tile file accepted, in bytes. */
  tileBytes: 512 * 1024,
  /** The most tiles one index may list. */
  tiles: 20_000,
  /** The largest index file read, in bytes. */
  indexBytes: 4 * 1024 * 1024,
  maxZoom: 16
} as const;

export type TileFormat = 'webp' | 'png';
export const TILE_FORMATS: readonly TileFormat[] = ['webp', 'png'];

/** One tile: its "z/x/y" path inside the set's folder (no extension), bytes, SHA-256 and the first 16 hex characters of its pixels' SHA-256. */
export type TileEntry = readonly [path: string, bytes: number, sha256: string, pixels: string];

export interface TileSet {
  readonly format: TileFormat;
  readonly minzoom: number;
  readonly maxzoom: number;
  readonly bounds: Bounds;
  readonly tiles: readonly TileEntry[];
}

export interface TileIndex {
  readonly format: typeof TILE_INDEX_FORMAT;
  readonly version: typeof TILE_INDEX_VERSION;
  readonly sets: Readonly<Record<string, TileSet>>;
}

export type TileResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly string[] };

// ---- Web Mercator ------------------------------------------------------------------------------------------------------------------------------

/** Longitude to the world's x in tiles at zoom z (0 at the antimeridian, 2^z at the other side). */
export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

/** Latitude to the world's y in tiles at zoom z (0 at the north edge). */
export function latToTileY(lat: number, z: number): number {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const r = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** The tiles at zoom z that touch a box, as [x, y] pairs in row order. */
export function tilesCovering(bounds: Bounds, z: number): Array<[number, number]> {
  const n = 2 ** z;
  const x0 = Math.max(0, Math.floor(lonToTileX(bounds[0], z))), x1 = Math.min(n - 1, Math.floor(lonToTileX(bounds[2], z) - 1e-9));
  const y0 = Math.max(0, Math.floor(latToTileY(bounds[3], z))), y1 = Math.min(n - 1, Math.floor(latToTileY(bounds[1], z) - 1e-9));
  const out: Array<[number, number]> = [];
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) out.push([x, y]);
  return out;
}

/** Whether tile z/x/y touches a box (edges included, so a tile beside the box is not taken for inside it). */
export function tileTouches(bounds: Bounds, z: number, x: number, y: number): boolean {
  const west = tileXToLon(x, z), east = tileXToLon(x + 1, z), north = tileYToLat(y, z), south = tileYToLat(y + 1, z);
  return east > bounds[0] && west < bounds[2] && north > bounds[1] && south < bounds[3];
}

// ---- Terrarium ---------------------------------------------------------------------------------------------------------------------------------
//
// MapLibre's terrarium decoding (the vendored worker): height = R * 256 + G + B / 256 - 32768. The encoder below is its exact inverse for heights on
// a 1/256 m step from -32768 m up.

/** The RGB of a height in metres, rounded to `step` metres (a power of two no finer than 1/256, so the blue channel stays coarse and compresses). */
export function terrariumEncode(metres: number, step = 1): [number, number, number] {
  const q = Math.round(metres / step) * step;
  const v = Math.max(0, Math.min(65535.996, q + 32768));
  const whole = Math.floor(v);
  return [Math.floor(whole / 256), whole % 256, Math.round((v - whole) * 256) & 255];
}

/** The height an RGB means, with MapLibre's own factors. */
export function terrariumDecode(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

// ---- Digests and magic bytes ---------------------------------------------------------------------------------------------------------------------

export function sha256Of(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The first 16 hex characters of the SHA-256 of a tile's RGBA pixels, before encoding. */
export function pixelDigest(rgba: Uint8Array | Uint8ClampedArray): string {
  return sha256Of(rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)).slice(0, 16);
}

/** Whether bytes start the way a file of this format must: the PNG signature, or a RIFF container of WEBP. */
export function hasMagic(bytes: Uint8Array, format: TileFormat): boolean {
  if (format === 'png') return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b);
  return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
}

// ---- The index -------------------------------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const SET_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A tile path: "z/x/y" in plain decimal digits, nothing else (no dots, slashes at either end, backslashes or drive letters). */
const TILE_PATH = /^(0|[1-9]\d?)\/(0|[1-9]\d{0,5})\/(0|[1-9]\d{0,5})$/;

/** The z, x and y of a tile path, or undefined when the path is anything but three plain numbers. */
export function parseTilePath(path: string): [number, number, number] | undefined {
  const match = TILE_PATH.exec(path);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export interface TileIndexOptions {
  /** The sets the caller needs; any other set is a problem, so an index cannot add files the caller did not ask for. */
  readonly sets?: readonly string[];
  /** A box every set must lie inside (the pack's bounds), with a small allowance for the tile edges. */
  readonly within?: Bounds;
}

/** Checks an index's shape: the format, every set's zoom range and bounds, and every tile entry's path, size and hashes. Returns every problem. */
export function checkTileIndex(value: unknown, options: TileIndexOptions = {}): TileResult<TileIndex> {
  const problems: string[] = [];
  if (!isObject(value)) return { ok: false, problems: ['tile index: not a JSON object.'] };
  for (const key of Object.keys(value)) if (!['format', 'version', 'sets'].includes(key)) problems.push(`tile index: unknown field "${key.slice(0, 40)}".`);
  if (value.format !== TILE_INDEX_FORMAT) problems.push(`tile index: format must be "${TILE_INDEX_FORMAT}".`);
  if (value.version !== TILE_INDEX_VERSION) problems.push(`tile index: version ${String(value.version).slice(0, 20)} is not supported.`);
  if (!isObject(value.sets) || Object.keys(value.sets).length === 0) return { ok: false, problems: [...problems, 'tile index: sets must name at least one tile set.'] };
  let total = 0;
  for (const [id, set] of Object.entries(value.sets)) {
    const where = `tile index set "${id.slice(0, 40)}"`;
    if (!SET_ID.test(id)) { problems.push(`${where}: a set id is lowercase letters, digits and hyphens.`); continue; }
    if (options.sets && !options.sets.includes(id)) { problems.push(`${where}: not a set this folder may have.`); continue; }
    if (!isObject(set)) { problems.push(`${where}: not an object.`); continue; }
    for (const key of Object.keys(set)) if (!['format', 'minzoom', 'maxzoom', 'bounds', 'tiles'].includes(key)) problems.push(`${where}: unknown field "${key.slice(0, 40)}".`);
    if (!TILE_FORMATS.includes(set.format as TileFormat)) problems.push(`${where}: format must be webp or png.`);
    const { minzoom, maxzoom } = set;
    if (!Number.isSafeInteger(minzoom) || !Number.isSafeInteger(maxzoom) || (minzoom as number) < 0 || (maxzoom as number) > TILE_LIMITS.maxZoom || (minzoom as number) > (maxzoom as number)) {
      problems.push(`${where}: minzoom and maxzoom must be whole numbers from 0 to ${TILE_LIMITS.maxZoom}, minzoom first.`);
      continue;
    }
    const b = set.bounds;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((n) => typeof n === 'number' && Number.isFinite(n)) || !(b[0] < b[2]) || !(b[1] < b[3]) || b[0] < -180 || b[2] > 180 || b[1] < -90 || b[3] > 90) {
      problems.push(`${where}: bounds must be [west, south, east, north] in degrees.`);
      continue;
    }
    const bounds = b as unknown as Bounds;
    if (options.within) {
      const w = options.within, e = 1e-6;
      if (bounds[0] < w[0] - e || bounds[1] < w[1] - e || bounds[2] > w[2] + e || bounds[3] > w[3] + e) problems.push(`${where}: its bounds reach outside the pack's bounds.`);
    }
    if (!Array.isArray(set.tiles) || set.tiles.length === 0) { problems.push(`${where}: tiles must list at least one tile.`); continue; }
    total += set.tiles.length;
    if (total > TILE_LIMITS.tiles) { problems.push(`tile index: more than ${TILE_LIMITS.tiles} tiles.`); break; }
    const seen = new Set<string>();
    let reported = 0;
    const report = (text: string) => { if (reported < 5) problems.push(text); reported += 1; };
    for (const entry of set.tiles) {
      if (!Array.isArray(entry) || entry.length !== 4) { report(`${where}: a tile entry is [path, bytes, sha256, pixel digest].`); continue; }
      const [path, bytes, sha, pixels] = entry as unknown[];
      const zxy = typeof path === 'string' ? parseTilePath(path) : undefined;
      if (!zxy) { report(`${where}: tile path ${JSON.stringify(String(path).slice(0, 60))} is not "z/x/y" in plain numbers (a path may never leave its folder).`); continue; }
      const [z, x, y] = zxy;
      if (z < (minzoom as number) || z > (maxzoom as number)) report(`${where}: tile ${path} is outside the set's zoom range.`);
      else if (x >= 2 ** z || y >= 2 ** z || !tileTouches(bounds, z, x, y)) report(`${where}: tile ${path} lies outside the set's bounds.`);
      if (!Number.isSafeInteger(bytes) || (bytes as number) < 8 || (bytes as number) > TILE_LIMITS.tileBytes) report(`${where}: tile ${path} must be 8 to ${TILE_LIMITS.tileBytes} bytes.`);
      if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) report(`${where}: tile ${path} needs a SHA-256 of 64 lowercase hex characters.`);
      if (typeof pixels !== 'string' || !/^[0-9a-f]{16}$/.test(pixels)) report(`${where}: tile ${path} needs a pixel digest of 16 lowercase hex characters.`);
      if (seen.has(path as string)) report(`${where}: tile ${path} is listed twice.`);
      seen.add(path as string);
    }
    if (reported > 5) problems.push(`${where}: ${reported - 5} more tile problems.`);
  }
  return problems.length ? { ok: false, problems } : { ok: true, value: value as unknown as TileIndex };
}

/** The file of a tile entry, relative to the folder that holds index.json: "<set>/<z>/<x>/<y>.<format>". */
export function tileFile(setId: string, set: Pick<TileSet, 'format'>, path: string): string {
  return `${setId}/${path}.${set.format}`;
}

/** Checks one tile's bytes against its entry: the size, the format's magic bytes, then the SHA-256. Undefined when it matches. */
export function tileProblem(setId: string, set: Pick<TileSet, 'format'>, entry: TileEntry, bytes: Uint8Array): string | undefined {
  const name = tileFile(setId, set, entry[0]);
  if (bytes.length !== entry[1]) return `${name}: ${bytes.length} bytes, but the index records ${entry[1]}.`;
  if (!hasMagic(bytes, set.format)) return `${name}: not a ${set.format.toUpperCase()} file.`;
  if (sha256Of(bytes) !== entry[2]) return `${name}: its SHA-256 does not match the index.`;
  return undefined;
}

/**
 * Writes an index in its committed form: the sets in the given order, one tile per line sorted by zoom, then x, then y, so a regenerated folder
 * gives the same bytes and a change shows as a few changed lines.
 */
export function writeTileIndex(sets: ReadonlyArray<readonly [id: string, set: TileSet]>): string {
  const parts = sets.map(([id, set]) => {
    const tiles = [...set.tiles].sort((a, b) => {
      const pa = parseTilePath(a[0])!, pb = parseTilePath(b[0])!;
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
    const head = `${JSON.stringify(id)}:{"format":${JSON.stringify(set.format)},"minzoom":${set.minzoom},"maxzoom":${set.maxzoom},"bounds":${JSON.stringify(set.bounds)},"tiles":[\n`;
    return head + tiles.map((tile) => JSON.stringify(tile)).join(',\n') + '\n]}';
  });
  return `{"format":${JSON.stringify(TILE_INDEX_FORMAT)},"version":${TILE_INDEX_VERSION},"sets":{${parts.join(',')}}}\n`;
}
