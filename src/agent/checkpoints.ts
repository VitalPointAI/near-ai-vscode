import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

interface Snapshot { path: string; original: string | null }

/**
 * Records each file's state before a run first changes it, so the whole run can be undone.
 * Snapshots are kept in memory and mirrored to `storageDir` so a revert still works after a
 * reload. Changes made by shell commands are not captured; only the file tools call `capture`.
 */
export class RunCheckpoints {
  private readonly snapshots = new Map<string, Snapshot>();

  public constructor(public readonly runId: string, private readonly storageDir?: string) {}

  /** Call before writing `absolutePath`; only the first call per file in a run takes a snapshot. */
  public async capture(absolutePath: string): Promise<void> {
    if (this.snapshots.has(absolutePath)) return;
    let original: string | null;
    try { original = (await readFile(absolutePath)).toString('base64'); } catch { original = null; }
    this.snapshots.set(absolutePath, { path: absolutePath, original });
    await this.persist();
  }

  public get changedFiles(): string[] { return [...this.snapshots.keys()]; }

  /** Restores every captured file to its state before the run; files the run created are deleted. */
  public async revert(): Promise<string[]> {
    const restored: string[] = [];
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.original === null) {
        await unlink(snapshot.path).catch(() => undefined);
      } else {
        await mkdir(path.dirname(snapshot.path), { recursive: true });
        await writeFile(snapshot.path, Buffer.from(snapshot.original, 'base64'));
      }
      restored.push(snapshot.path);
    }
    this.snapshots.clear();
    if (this.storageDir) await rm(this.file(), { force: true });
    return restored;
  }

  /** Reloads a run's snapshots saved by an earlier session. */
  public static async load(runId: string, storageDir: string): Promise<RunCheckpoints | undefined> {
    const checkpoints = new RunCheckpoints(runId, storageDir);
    try {
      const saved = JSON.parse(await readFile(checkpoints.file(), 'utf8')) as Snapshot[];
      for (const snapshot of saved) checkpoints.snapshots.set(snapshot.path, snapshot);
      return checkpoints;
    } catch {
      return undefined;
    }
  }

  private file(): string { return path.join(this.storageDir ?? '', `${this.runId}.json`); }

  private async persist(): Promise<void> {
    if (!this.storageDir) return;
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(this.file(), JSON.stringify([...this.snapshots.values()]), 'utf8');
  }
}
