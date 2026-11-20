// The map tiles the COP map may load (research note "COP map: photo-realistic imagery, 3D globe, 3D terrain and topographic base"): the bundled
// world tiles of the globe (media/map/globe/) and the tiles of a scenario's environment pack (resources/staff/env/<scenario>/tiles/). Node I/O only,
// no vscode import: the caller passes a function that turns a folder into a webview address.
//
// Nothing is ever fetched from a server. Before the page gets any tile address, the host checks the folder against its index: the index's SHA-256
// against the record that names it (media/map/globe/DATA.json, or the pack's manifest), the index's shape (src/domain/staff/env/tiles.ts), and then
// every tile it lists: a regular file, the size the index records, the right magic bytes for its format, and the right SHA-256. One problem refuses
// the whole folder, and the map says why and draws without it. A folder is checked once per session for each index hash (about 6 MB to hash).
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { checkTileIndex, TILE_INDEX_FILE, TILE_LIMITS, tileFile, tileProblem } from '../domain/staff/env/tiles';
import type { TileIndex, TileIndexOptions, TileResult } from '../domain/staff/env/tiles';
import { ENV_LIMITS, ENV_MANIFEST, ENV_TILE_INDEX, ENV_TILE_SETS, checkManifest } from '../domain/staff/env/pack';
import type { Bounds } from '../domain/staff/env/pack';
import type { Scenario } from '../domain/staff/scenario';
import { BUNDLED_ENV_DIR } from './envPack';

/** The bundled world tiles of the globe. */
export const GLOBE_DIR = path.join(__dirname, '..', '..', 'media', 'map', 'globe');
export const GLOBE_DATA = 'DATA.json';
export const GLOBE_SETS = ['blue-marble', 'natural-earth'] as const;

/** One tile source as the page gets it: a {z}/{x}/{y} address template and the set's zooms and bounds, so MapLibre asks only for tiles that exist. */
export interface MapTileSource {
  readonly tiles: string;
  readonly minzoom: number;
  readonly maxzoom: number;
  readonly bounds: Bounds;
}

/** What the page may draw under the picture. Every source is optional: a refused or missing folder leaves its sources out and says why. */
export interface CopBasemap {
  readonly globe?: { readonly imagery?: MapTileSource; readonly topo?: MapTileSource; readonly credit: { readonly imagery: string; readonly topo: string } };
  readonly frame?: {
    readonly imagery?: MapTileSource; readonly imageryDetail?: MapTileSource; readonly terrain?: MapTileSource; readonly relief?: MapTileSource;
    /** The pack's landcover.geojson (checked against the manifest's hash), which the topographic map loads itself instead of the picture carrying it. */
    readonly landcover?: string;
    readonly synthetic: boolean;
  };
  readonly problems: readonly string[];
}

const checked = new Map<string, TileResult<TileIndex>>();

async function regularFile(file: string, maxBytes: number): Promise<{ readonly bytes?: Uint8Array; readonly problem?: string }> {
  let info;
  try { info = await lstat(file); } catch (error) { return { problem: `${path.basename(file)} could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'}).` }; }
  if (!info.isFile()) return { problem: `${path.basename(file)} is not a regular file.` };
  if (info.size > maxBytes) return { problem: `${path.basename(file)} is larger than ${maxBytes} bytes.` };
  return { bytes: await readFile(file) };
}

/**
 * Checks a tile folder: its index against `indexSha256` (when given), the index's shape, then every listed tile's size, magic bytes and SHA-256.
 * Refuses on the first tile problems found (at most five are reported).
 */
export async function checkTileFolder(dir: string, indexSha256: string | undefined, options: TileIndexOptions): Promise<TileResult<TileIndex>> {
  const read = await regularFile(path.join(dir, TILE_INDEX_FILE), TILE_LIMITS.indexBytes);
  if (!read.bytes) return { ok: false, problems: [read.problem ?? 'the tile index could not be read.'] };
  const sha = createHash('sha256').update(read.bytes).digest('hex');
  if (indexSha256 !== undefined && sha !== indexSha256) return { ok: false, problems: ['the tile index does not match the hash its record holds; the tiles were changed after they were made.'] };
  const key = `${dir}|${sha}|${JSON.stringify(options)}`;
  const known = checked.get(key);
  if (known) return known;
  let json: unknown;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)); } catch { return { ok: false, problems: ['the tile index is not valid UTF-8 JSON.'] }; }
  const index = checkTileIndex(json, options);
  let result: TileResult<TileIndex> = index;
  if (index.ok) {
    const problems: string[] = [];
    for (const [setId, set] of Object.entries(index.value.sets)) {
      for (const entry of set.tiles) {
        const file = await regularFile(path.join(dir, ...tileFile(setId, set, entry[0]).split('/')), TILE_LIMITS.tileBytes);
        const problem = file.bytes ? tileProblem(setId, set, entry, file.bytes) : `${tileFile(setId, set, entry[0])}: ${file.problem}`;
        if (problem) problems.push(problem);
        if (problems.length >= 5) break;
      }
      if (problems.length >= 5) break;
    }
    if (problems.length) result = { ok: false, problems };
  }
  if (checked.size > 16) checked.clear();
  checked.set(key, result);
  return result;
}

/** The template of a set's tiles under a folder's webview address. */
function source(base: string, setId: string, index: TileIndex): MapTileSource | undefined {
  const set = index.sets[setId];
  if (!set) return undefined;
  return { tiles: `${base.replace(/\/+$/, '')}/${setId}/{z}/{x}/{y}.${set.format}`, minzoom: set.minzoom, maxzoom: set.maxzoom, bounds: set.bounds };
}

/**
 * The basemap of the COP map for a webview: the globe's world imagery and topographic tiles, and the scenario pack's imagery and heights, each
 * only after its folder passed the checks. `uri` turns an absolute folder into its webview address (asWebviewUri(...).toString()).
 */
export async function copBasemap(uri: (dir: string) => string, scenario?: Pick<Scenario, 'id' | 'region'>, dirs: { readonly globe?: string; readonly env?: string } = {}): Promise<CopBasemap> {
  const problems: string[] = [];
  let globe: CopBasemap['globe'];
  const globeDir = dirs.globe ?? GLOBE_DIR;
  try {
    const data = await regularFile(path.join(globeDir, GLOBE_DATA), 1024 * 1024);
    const record = data.bytes ? JSON.parse(new TextDecoder().decode(data.bytes)) as { indexSha256?: unknown; sets?: Array<{ id?: unknown; credit?: unknown }> } : undefined;
    if (!record || typeof record.indexSha256 !== 'string') problems.push(`The world imagery was left out: ${data.problem ?? 'its data record names no index hash'}`);
    else {
      const index = await checkTileFolder(globeDir, record.indexSha256, { sets: GLOBE_SETS, within: [-180, -85.06, 180, 85.06] });
      if (!index.ok) problems.push(`The world imagery was left out: ${index.problems.slice(0, 2).join(' ')}`);
      else {
        const credit = (id: string) => { const c = record.sets?.find((set) => set.id === id)?.credit; return typeof c === 'string' ? c.slice(0, 120) : ''; };
        const base = uri(globeDir);
        globe = { imagery: source(base, 'blue-marble', index.value), topo: source(base, 'natural-earth', index.value), credit: { imagery: credit('blue-marble'), topo: credit('natural-earth') } };
      }
    }
  } catch (error) { problems.push(`The world imagery was left out: ${error instanceof Error ? error.message : String(error)}`); }

  let frame: CopBasemap['frame'];
  if (scenario?.region.frame && /^[a-z0-9][a-z0-9-]{0,63}$/.test(scenario.id)) {
    const packDir = path.join(dirs.env ?? BUNDLED_ENV_DIR, scenario.id);
    const manifestFile = await regularFile(path.join(packDir, ENV_MANIFEST), 1024 * 1024);
    if (manifestFile.bytes) {
      let manifest;
      try { manifest = checkManifest(JSON.parse(new TextDecoder().decode(manifestFile.bytes))); } catch { manifest = undefined; }
      if (!manifest || !manifest.ok) problems.push('The terrain imagery was left out: the pack manifest is not valid.');
      else if (manifest.value.tiles) {
        const tilesDir = path.join(packDir, ...path.posix.dirname(ENV_TILE_INDEX).split('/'));
        const cover = manifest.value.files.landcover;
        let landcover: string | undefined;
        if (cover) {
          const file = await regularFile(path.join(packDir, cover.path), ENV_LIMITS.fileBytes);
          if (file.bytes && file.bytes.length === cover.bytes && createHash('sha256').update(file.bytes).digest('hex') === cover.sha256) landcover = `${uri(packDir).replace(/\/+$/, '')}/${cover.path}`;
          else problems.push('The land cover was left out: landcover.geojson does not match the pack manifest.');
        }
        const index = await checkTileFolder(tilesDir, manifest.value.tiles.sha256, { sets: ENV_TILE_SETS, within: manifest.value.bounds });
        if (!index.ok) problems.push(`The terrain imagery and 3D heights were left out: ${index.problems.slice(0, 2).join(' ')}`);
        else {
          const base = uri(tilesDir);
          frame = {
            imagery: source(base, 'imagery', index.value), imageryDetail: source(base, 'imagery-detail', index.value),
            terrain: source(base, 'terrain', index.value), relief: source(base, 'relief', index.value), ...(landcover ? { landcover } : {}), synthetic: manifest.value.data === 'synthetic'
          };
        }
      }
    }
  }
  return { ...(globe ? { globe } : {}), ...(frame ? { frame } : {}), problems };
}
