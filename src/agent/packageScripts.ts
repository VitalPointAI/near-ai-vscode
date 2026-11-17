// The package.json scripts a package manager would run in a folder, for the shell classifier (PR #74 review round 4). npm, yarn, pnpm and bun use the
// nearest package.json at or above the folder they run in, so `cd sub && npm run x` runs sub/package.json's x. The reader finds that file, reads its
// scripts, and reads the file again for every decision (a run can rewrite a script and then run it, and a same-size rewrite within the clock's resolution
// keeps its size and time, PR #74 review round 8); only the parse is kept, by the file's content. It only reads
// package.json files; it runs nothing.
import { createHash } from 'node:crypto';
import { readFileSync as nodeReadFileSync, statSync as nodeStatSync } from 'node:fs';
import * as path from 'node:path';
import type { PackageScriptsAt } from './commandSafety';

/** The two file calls the reader makes; a test gives its own to count reads. */
export interface PackageScriptsFs {
  readonly statSync: typeof nodeStatSync;
  readonly readFileSync: typeof nodeReadFileSync;
}

interface Cached { readonly hash: string; readonly result: PackageScriptsAt }

export class PackageScriptsReader {
  private readonly cache = new Map<string, Cached>();

  public constructor(private readonly fs: PackageScriptsFs = { statSync: nodeStatSync, readFileSync: nodeReadFileSync }) {}

  /** What the package.json a package manager would use in `folder` says, judged against the project `root`. Never throws. */
  public at(folder: string, root: string): PackageScriptsAt {
    const project = path.resolve(root);
    let current = path.resolve(folder);
    if (!inside(project, current)) return { kind: 'outside', folder: current };
    for (;;) {
      const file = path.join(current, 'package.json');
      let info: { size: number; mtimeMs: number; isFile(): boolean } | undefined;
      try {
        info = this.fs.statSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') return { kind: 'unreadable', folder: current };
      }
      if (info !== undefined) {
        if (!inside(project, current)) return { kind: 'outside', folder: current };
        if (!info.isFile()) return { kind: 'unreadable', folder: current };
        // Read for every decision; parsed again only when the content differs from the last read.
        let text: string;
        try {
          text = String(this.fs.readFileSync(file, 'utf8'));
        } catch {
          return { kind: 'unreadable', folder: current };
        }
        const hash = createHash('sha256').update(text).digest('hex');
        const cached = this.cache.get(file);
        if (cached !== undefined && cached.hash === hash) return cached.result;
        const result = this.parse(text, current);
        this.cache.set(file, { hash, result });
        return result;
      }
      const parent = path.dirname(current);
      if (parent === current) return { kind: 'none' };
      current = parent;
    }
  }

  private parse(text: string, folder: string): PackageScriptsAt {
    try {
      const manifest = JSON.parse(text) as { scripts?: unknown };
      const raw = manifest.scripts;
      const scripts = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {};
      return { kind: 'found', folder, scripts };
    } catch {
      return { kind: 'unreadable', folder };
    }
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
