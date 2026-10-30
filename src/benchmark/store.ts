import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSavedRun, RUN_ID, serializeRun, type SavedRun } from './results';

// Saved model comparisons: one JSON file per comparison in the extension's global storage
// (<globalStorage>/evals/<run id>.json), written as each result arrives so a closed window loses
// nothing. Shared by every project: a model's ability does not depend on the folder it was tested from.

export class ComparisonStore {
  public constructor(public readonly dir: string) {}

  public fileFor(id: string): string {
    if (!RUN_ID.test(id)) throw new Error(`Not a saved comparison ID: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  /** Writes the whole run; a reader never sees a half-written file. */
  public async save(saved: SavedRun): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.fileFor(saved.id);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, serializeRun(saved), 'utf8');
    await rename(temporary, file);
  }

  public async load(id: string): Promise<SavedRun | undefined> {
    return parseSavedRun(await readFile(this.fileFor(id), 'utf8').catch(() => ''));
  }

  /** Every readable saved comparison, newest first; damaged or unrelated files are skipped. */
  public async list(): Promise<SavedRun[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const runs = await Promise.all(names.filter((name) => name.endsWith('.json') && RUN_ID.test(name.slice(0, -5))).map((name) => readFile(path.join(this.dir, name), 'utf8').then(parseSavedRun, () => undefined)));
    return runs.filter((saved): saved is SavedRun => Boolean(saved)).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  }

  /** A run ID not yet used in this folder (two comparisons started in the same millisecond get a suffix). */
  public async newId(base: string): Promise<string> {
    const taken = new Set(await readdir(this.dir).catch(() => [] as string[]));
    if (!taken.has(`${base}.json`)) return base;
    for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}.json`)) return `${base}-${n}`;
  }
}
