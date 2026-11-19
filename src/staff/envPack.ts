// Reading environment packs from disk (WP-ENV; src/domain/staff/env/pack.ts has the format and the checks). Node I/O only, no vscode import.
//
// The extension reads only finished packs: JSON files it checks against the manifest's hashes before parsing anything else, never a GeoTIFF, GRIB2
// or NetCDF file (those are the pack builder's, on a developer machine with GDAL). It reads only the four file names of the format, each a regular
// file no larger than the format's cap, so a manifest cannot make it read anything else. The bundled pack of a scenario lives in
// resources/staff/env/<scenario id>/ and is drawn only when every coordinate lies inside that scenario's frame.
import { lstat, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ENV_FILES, ENV_LIMITS, ENV_MANIFEST, readEnvPack, sha256Hex } from '../domain/staff/env/pack';
import type { EnvPack, PackCheckOptions, PackResult } from '../domain/staff/env/pack';
import { pictureEnvironment } from '../domain/staff/cop/environment';
import type { PictureEnvironment } from '../domain/staff/cop/environment';
import type { Scenario } from '../domain/staff/scenario';

/** Where the extension's bundled packs are, one folder per scenario id. */
export const BUNDLED_ENV_DIR = path.join(__dirname, '..', '..', 'resources', 'staff', 'env');

/** Reads a pack folder and validates it. A missing manifest is `undefined` (no pack); anything else wrong is a refusal with its reasons. */
export async function readEnvPackDir(dir: string, options: PackCheckOptions = {}): Promise<PackResult<EnvPack> | undefined> {
  const files: Record<string, Uint8Array> = {};
  for (const name of [ENV_MANIFEST, ...Object.values(ENV_FILES)]) {
    const file = path.join(dir, name);
    let info;
    try { info = await lstat(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (name === ENV_MANIFEST) return undefined; continue; }
      return { ok: false, problems: [`${name} could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'}).`] };
    }
    if (!info.isFile()) return { ok: false, problems: [`${name} is not a regular file.`] };
    if (info.size > ENV_LIMITS.fileBytes) return { ok: false, problems: [`${name} is larger than ${ENV_LIMITS.fileBytes} bytes.`] };
    files[name] = await readFile(file);
  }
  return readEnvPack(files, options);
}

const cache = new Map<string, PictureEnvironment>();

/**
 * The environment layers for a scenario from its bundled pack, or why the pack was refused. `undefined` when the scenario has no frame or no
 * bundled pack. The layers are computed once per pack content and frame, so the Staff Room's frequent picture updates do not redo the contours.
 */
export async function scenarioEnvironment(scenario: Pick<Scenario, 'id' | 'region'>, dir: string = BUNDLED_ENV_DIR): Promise<{ readonly environment?: PictureEnvironment; readonly problem?: string } | undefined> {
  const frame = scenario.region.frame;
  if (!frame || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(scenario.id)) return undefined;
  const folder = path.join(dir, scenario.id);
  const read = await readEnvPackDir(folder, { frame, scenario: scenario.id });
  if (!read) return undefined;
  if (!read.ok) return { problem: `the environment pack was refused: ${read.problems.slice(0, 3).join(' ')}` };
  const key = `${folder}|${JSON.stringify(frame)}|${sha256Hex(JSON.stringify(read.value.manifest.files))}`;
  let environment = cache.get(key);
  if (!environment) {
    environment = pictureEnvironment(read.value);
    if (cache.size > 8) cache.clear();
    cache.set(key, environment);
  }
  return { environment };
}
