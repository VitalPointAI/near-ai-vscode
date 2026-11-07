// The one-time move of a person's teams from the extension's storage to their home folder (owner, 2026-11-06). Run once at start, before the sidebar or
// Team Studio reads the library:
//   - copy, never move: the old files stay, so going back to an older version of the extension still finds them;
//   - never overwrite: a file already in the new folder may be the newer one, so an existing name is skipped and counted;
//   - never fail a start: a folder that cannot be read or written leaves the person with whatever is already in place.
import { copyFile, mkdir, readdir, rename, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { legacyTeamsDirectory, sameFolder, teamsDirectory } from '../domain/teamStorage';

export interface TeamMoveResult { moved: number; skipped: number }

/** Every file under a folder, as paths relative to it, or an empty list when the folder is not there. */
async function filesUnder(root: string, relative = ''): Promise<string[]> {
  const here = path.join(root, relative);
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(here, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(root, next));
    else if (entry.isFile()) found.push(next);
  }
  return found;
}

async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; } catch { return false; }
}

/**
 * Copies the teams saved under the old extension storage into the person's home folder. Safe to run on every start: a file already present is skipped, so
 * the second run does nothing. Returns how many files were copied and how many were left alone.
 */
export async function migrateTeams(options: { home: string; globalStorage: string; env?: NodeJS.ProcessEnv }): Promise<TeamMoveResult> {
  const env = options.env ?? process.env;
  const target = path.join(teamsDirectory(options.home, env), 'teams');
  const source = legacyTeamsDirectory(options.globalStorage);
  // The new folder is the old one (a person who set the environment variable to it): nothing to do, and copying onto itself would corrupt files.
  if (sameFolder(source, target)) return { moved: 0, skipped: 0 };
  const files = await filesUnder(source);
  let moved = 0;
  let skipped = 0;
  for (const file of files) {
    const from = path.join(source, file);
    const to = path.join(target, file);
    if (await exists(to)) { skipped += 1; continue; }
    try {
      await mkdir(path.dirname(to), { recursive: true });
      // Copy to a temporary name and rename it into place (0.4.18 review): a copy that fails half way (a full disk, a permission) must not leave a
      // truncated team that every later run then treats as already present.
      const temporary = `${to}.copying`;
      await copyFile(from, temporary);
      await rename(temporary, to);
      moved += 1;
    } catch {
      // One file that cannot be copied (a permission, a full disk) must not stop the rest or fail the start.
      skipped += 1;
    }
  }
  return { moved, skipped };
}
