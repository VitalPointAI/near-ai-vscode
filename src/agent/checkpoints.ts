import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

interface Snapshot { path: string; original: string | null }

/** What is on disk (format 2): a file inside the project is a path relative to the project root, so the checkpoint works on any machine that has the project. */
type SavedSnapshot = ({ rel: string } | { abs: string; outside: true }) & { original: string | null };
const FORMAT = 2;

export interface RunCheckpointsOptions {
  /** The project folder. Files inside it are saved as root-relative paths; without it every path is saved as an absolute outside path. */
  root?: string;
  /** Awaited before each save; the chat passes the state home's ensure(), so its inner .gitignore exists before the first checkpoint file. */
  beforeWrite?: () => Promise<unknown>;
}

/** A temporary file this old is left over from a save that never finished (the editor closed between write and rename); a live save takes milliseconds. */
const STALE_TEMPORARY_MS = 60_000;

/**
 * Records each file's state before a run first changes it, so the whole run can be undone.
 * Snapshots are kept in memory and mirrored to `storageDir` so a revert still works after a
 * reload. Changes made by shell commands are not captured; only the file tools call `capture`.
 */
export class RunCheckpoints {
  private readonly snapshots = new Map<string, Snapshot>();
  /** Saves run one after another: parallel sub-agents capture at the same time, and two writes of one file could interleave. */
  private saving: Promise<void> = Promise.resolve();
  private swept = false;

  private readonly root: string | undefined;
  private readonly beforeWrite: (() => Promise<unknown>) | undefined;

  public constructor(public readonly runId: string, private readonly storageDir?: string, options: RunCheckpointsOptions = {}) {
    this.root = options.root ? path.resolve(options.root) : undefined;
    this.beforeWrite = options.beforeWrite;
  }

  /** Call before writing `absolutePath`; only the first call per file in a run takes a snapshot. */
  public async capture(absolutePath: string): Promise<void> {
    if (this.snapshots.has(absolutePath)) return;
    let original: string | null;
    try { original = (await readFile(absolutePath)).toString('base64'); } catch { original = null; }
    this.snapshots.set(absolutePath, { path: absolutePath, original });
    await this.persist();
  }

  public get changedFiles(): string[] { return [...this.snapshots.keys()]; }

  /** A file's text before the run first changed it: null if the run created it, undefined if the run has not touched it. */
  public original(absolutePath: string): string | null | undefined {
    const snapshot = this.snapshots.get(absolutePath);
    if (!snapshot) return undefined;
    return snapshot.original === null ? null : Buffer.from(snapshot.original, 'base64').toString('utf8');
  }

  /** Restores every captured file to its state before the run; files the run created are deleted. */
  public async revert(): Promise<string[]> {
    const restored: string[] = [];
    for (const snapshot of this.snapshots.values()) {
      // A path that became a symlink since (e.g. via a shell command) is replaced, not written through.
      const isLink = await lstat(snapshot.path).then((info) => info.isSymbolicLink(), () => false);
      if (snapshot.original === null) {
        await unlink(snapshot.path).catch(() => undefined);
      } else {
        if (isLink) await unlink(snapshot.path);
        await mkdir(path.dirname(snapshot.path), { recursive: true });
        await writeFile(snapshot.path, Buffer.from(snapshot.original, 'base64'));
      }
      restored.push(snapshot.path);
    }
    this.snapshots.clear();
    // The removal joins the same queue as the saves, so a save queued before OR during the revert runs first and cannot bring the file back afterwards.
    if (this.storageDir) {
      const removed = this.saving.then(() => rm(this.file(), { force: true }));
      this.saving = removed.catch(() => undefined);
      await removed;
    }
    return restored;
  }

  /** Reloads a run's snapshots saved by an earlier session. */
  public static async load(runId: string, storageDir: string, options: RunCheckpointsOptions = {}): Promise<RunCheckpoints | undefined> {
    const checkpoints = new RunCheckpoints(runId, storageDir, options);
    await checkpoints.sweepTemporaries();
    try {
      const saved: unknown = JSON.parse(await readFile(checkpoints.file(), 'utf8'));
      for (const snapshot of checkpoints.readSaved(saved)) checkpoints.snapshots.set(snapshot.path, snapshot);
      return checkpoints;
    } catch {
      return undefined;
    }
  }

  /** Reads a saved file strictly. Format 1 (a list of absolute paths) and format 2 both load; an entry that is malformed or would land outside the root is dropped. */
  private readSaved(saved: unknown): Snapshot[] {
    const original = (value: unknown): string | null | undefined => (value === null || typeof value === 'string' ? value : undefined);
    const found: Snapshot[] = [];
    if (Array.isArray(saved)) {
      for (const item of saved as Array<Record<string, unknown>>) {
        const content = original(item?.original);
        if (item && typeof item.path === 'string' && path.isAbsolute(item.path) && content !== undefined) found.push({ path: item.path, original: content });
      }
      return found;
    }
    if (!saved || typeof saved !== 'object' || (saved as { format?: unknown }).format !== FORMAT || !Array.isArray((saved as { snapshots?: unknown }).snapshots)) return found;
    for (const item of (saved as { snapshots: Array<Record<string, unknown>> }).snapshots) {
      const content = original(item?.original);
      if (!item || content === undefined) continue;
      if (item.outside === true && typeof item.abs === 'string' && path.isAbsolute(item.abs)) { found.push({ path: item.abs, original: content }); continue; }
      if (typeof item.rel !== 'string' || !this.root) continue;
      const resolved = this.resolveInside(item.rel);
      if (resolved) found.push({ path: resolved, original: content });
    }
    return found;
  }

  /** A saved relative path made absolute under the root, or undefined when it is empty, absolute, climbs out with '..', or would resolve outside the root (T-27-17). */
  private resolveInside(rel: string): string | undefined {
    if (!this.root || !rel || rel.includes('\0') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).includes('..')) return undefined;
    const resolved = path.resolve(this.root, rel);
    return resolved === this.root || !resolved.startsWith(this.root + path.sep) ? undefined : resolved;
  }

  private toSaved(snapshot: Snapshot): SavedSnapshot {
    const rel = this.root ? path.relative(this.root, snapshot.path) : undefined;
    if (rel !== undefined && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return { rel: rel.split(path.sep).join('/'), original: snapshot.original };
    return { abs: snapshot.path, outside: true, original: snapshot.original };
  }

  /** Deletes this run's temporary files left by a save that was cut off; once per instance, and never one a save could still be renaming. */
  private async sweepTemporaries(): Promise<void> {
    if (this.swept || !this.storageDir) return;
    this.swept = true;
    const prefix = `.${this.runId}.`;
    const names = await readdir(this.storageDir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp') || !/^[0-9a-f]+$/.test(name.slice(prefix.length, -'.tmp'.length))) continue;
      const file = path.join(this.storageDir, name);
      const info = await stat(file).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > STALE_TEMPORARY_MS) await rm(file, { force: true }).catch(() => undefined);
    }
  }

  private file(): string { return path.join(this.storageDir ?? '', `${this.runId}.json`); }

  private persist(): Promise<void> {
    if (!this.storageDir) return Promise.resolve();
    const saved = this.saving.then(() => this.write());
    this.saving = saved.catch(() => undefined);
    return saved;
  }

  /** Writes every snapshot taken so far to a temporary file, then renames it over the saved one, so a reader never sees half a file. */
  private async write(): Promise<void> {
    const storageDir = this.storageDir!;
    await this.beforeWrite?.();
    await mkdir(storageDir, { recursive: true });
    await this.sweepTemporaries();
    const temporary = path.join(storageDir, `.${this.runId}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ format: FORMAT, snapshots: [...this.snapshots.values()].map((snapshot) => this.toSaved(snapshot)) }), 'utf8');
      await rename(temporary, this.file());
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
