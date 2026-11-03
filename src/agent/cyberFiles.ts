import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

// File discovery for the workspace-shaped defensive probes (committed secrets, IaC). The same
// bounded walk the agent's Glob uses: hidden and generated trees are skipped, depth and file count
// are capped, and nothing is read that is not a regular file of plausible size.

const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'out', '.next', '.cache', '.venv', 'venv', '__pycache__', 'target', 'vendor']);
const MAX_DEPTH = 6;
const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 1024 * 1024;

export interface WorkspaceFile { absolute: string; relative: string }

/** Every non-skipped regular file under root, as workspace-relative forward-slash paths. */
export async function walkWorkspace(root: string, options: { maxFiles?: number; maxDepth?: number } = {}): Promise<WorkspaceFile[]> {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const found: WorkspaceFile[] = [];
  const stack: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (stack.length && found.length < maxFiles) {
    const { directory, depth } = stack.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < maxDepth) stack.push({ directory: absolute, depth: depth + 1 });
      } else if (entry.isFile()) {
        found.push({ absolute, relative: path.relative(root, absolute).split(path.sep).join('/') });
      }
    }
  }
  return found.sort((a, b) => a.relative.localeCompare(b.relative));
}

/** The text of a file that is small enough to scan; undefined for binaries, oversized files, and misses. */
export async function readScannable(file: WorkspaceFile): Promise<string | undefined> {
  const info = await stat(file.absolute).catch(() => undefined);
  if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
  const bytes = await readFile(file.absolute).catch(() => undefined);
  if (!bytes) return undefined;
  if (bytes.subarray(0, 8_000).includes(0)) return undefined;
  return bytes.toString('utf8');
}

/** The 1-based line number of a byte offset in a text, for citing a finding at file:line. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) if (text[index] === '\n') line += 1;
  return line;
}
