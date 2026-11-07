// Making the project's scratch folder exist, keeping it out of git, and emptying it (owner, 2026-11-06): "scratch files/working drafts are not committed
// and are cleaned up when done being used so projects don't grow to stupid sizes".
//
// Run at activation: the folder exists so a run can use it, the project's .gitignore gains the two lines that keep it and the attachment copies out of
// git, and anything a killed run left behind is removed. A failure here never fails a start: the run's own instructions still name the folder.
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { gitignoreAdditions, scratchFolder } from '../domain/scratch';

async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; } catch { return false; }
}

/** Creates the scratch folder and adds the ignore lines the project's .gitignore does not already have. Returns the lines it added. */
export async function ensureScratch(root: string): Promise<string[]> {
  await mkdir(scratchFolder(root), { recursive: true }).catch(() => undefined);
  const file = path.join(root, '.gitignore');
  const current = await readFile(file, 'utf8').catch(() => undefined);
  const additions = gitignoreAdditions(current ?? '');
  if (current !== undefined && additions.length === 0) return [];
  const next = `${current === undefined ? '' : current.replace(/\n?$/, '\n')}\n# NEAR AI scratch work and attached copies (never committed, emptied after a run)\n${additions.join('\n')}\n`;
  try {
    await writeFile(file, next);
  } catch {
    return [];
  }
  return additions;
}

/**
 * Empties the scratch folder, keeping the folder itself so the next run has one. Returns how many files and folders were removed. Never throws.
 */
export async function cleanScratch(root: string, options: { staleOnlyMs?: number } = {}): Promise<number> {
  const folder = scratchFolder(root);
  if (!(await exists(folder))) return 0;
  // 0.4.18 review: the startup clean must not delete what a run in another window is using, so it removes only files older than `staleOnlyMs` (the
  // run that made them is gone). The clean at the end of a run removes everything, because no other run of that window is using the folder.
  const cutoff = options.staleOnlyMs === undefined ? undefined : Date.now() - options.staleOnlyMs;
  let entries: string[];
  try {
    entries = await readdir(folder);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    try {
      if (cutoff !== undefined) {
        const info = await stat(path.join(folder, entry)).catch(() => undefined);
        if (info !== undefined && info.mtimeMs > cutoff) continue;
      }
      await rm(path.join(folder, entry), { recursive: true, force: true });
      removed += 1;
    } catch {
      // One entry that cannot be removed leaves the rest to be removed; the folder may be in use by a running process.
    }
  }
  return removed;
}
