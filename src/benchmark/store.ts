import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { stateHomeFor, writeFileAtomic } from '../services/stateHome';
import { parseSavedRun, RUN_ID, serializeRun, type SavedRun } from './results';

// Saved model comparisons: one JSON file per comparison, written as each result arrives so a closed window loses nothing.
//
// A store reads and writes an ordered list of folders (D-06, SYNC-06). The first is the primary: for a project it is the project's state home
// (<project>/.near-ai/state/comparisons), so a comparison made in one editor is listed in every other editor on the host; the second is the editor's
// own global folder (<globalStorage>/evals), so other projects on this editor keep reusing results at no cost. A model's ability does not depend on
// the folder it was tested from. Listing reads every folder, keeps one run per id (the first folder wins) and never runs or pays for anything.

export class ComparisonStore {
  public readonly dirs: string[];

  /**
   * `prepare` runs before a folder is first written, so the state home is created (with its own inner .gitignore) before anything is placed in it.
   * Reading never calls it: opening a project writes nothing.
   */
  public constructor(dirs: string | string[], private readonly prepare?: (dir: string) => Promise<void>) {
    this.dirs = Array.isArray(dirs) ? [...dirs] : [dirs];
    if (!this.dirs.length) throw new Error('A comparison store needs at least one folder.');
  }

  /** The primary (first) folder. */
  public get dir(): string {
    return this.dirs[0]!;
  }

  public fileFor(id: string, dir: string = this.dir): string {
    if (!RUN_ID.test(id)) throw new Error(`Not a saved comparison ID: ${id}`);
    return path.join(dir, `${id}.json`);
  }

  /**
   * Writes the whole run to every folder, each through a temporary name nobody else shares and an atomic rename, so a reader never sees a
   * half-written file. One folder failing (a read-only project, say) does not lose the others; it only throws when no folder took the run.
   */
  public async save(saved: SavedRun): Promise<void> {
    const text = serializeRun(saved);
    const results = await Promise.allSettled(this.dirs.map(async (dir) => {
      await this.prepare?.(dir);
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(this.fileFor(saved.id, dir), text, { mode: 0o644 });
    }));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed && results.every((result) => result.status === 'rejected')) throw failed.reason;
  }

  public async load(id: string): Promise<SavedRun | undefined> {
    for (const dir of this.dirs) {
      const saved = parseSavedRun(await readFile(this.fileFor(id, dir), 'utf8').catch(() => ''));
      if (saved) return saved;
    }
    return undefined;
  }

  /** Every readable saved comparison in every folder, newest first; damaged or unrelated files are skipped. */
  public async list(): Promise<SavedRun[]> {
    const perFolder = await Promise.all(this.dirs.map(async (dir) => {
      const names = await readdir(dir).catch(() => [] as string[]);
      const runs = await Promise.all(names.filter((name) => name.endsWith('.json') && RUN_ID.test(name.slice(0, -5))).map((name) => readFile(path.join(dir, name), 'utf8').then(parseSavedRun, () => undefined)));
      return runs.filter((saved): saved is SavedRun => Boolean(saved));
    }));
    const byId = new Map<string, SavedRun>();
    for (const runs of perFolder) for (const saved of runs) if (!byId.has(saved.id)) byId.set(saved.id, saved);
    return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  }

  /** A run ID not yet used in any folder (two comparisons started in the same millisecond get a suffix). */
  public async newId(base: string): Promise<string> {
    const taken = new Set<string>();
    for (const dir of this.dirs) for (const name of await readdir(dir).catch(() => [] as string[])) taken.add(name);
    if (!taken.has(`${base}.json`)) return base;
    for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}.json`)) return `${base}-${n}`;
  }
}

/**
 * The store for one editor and project: the project's state home first, then the editor's global evals folder. Without a project folder it is the
 * global folder only, exactly as before the state home existed.
 */
export function comparisonStoreFor(globalStorageDir: string, root?: string): ComparisonStore {
  const global = path.join(globalStorageDir, 'evals');
  if (!root) return new ComparisonStore(global);
  const home = stateHomeFor(root);
  return new ComparisonStore([home.paths.comparisons, global], async (dir) => {
    if (dir === home.paths.comparisons) await home.ensure();
  });
}
