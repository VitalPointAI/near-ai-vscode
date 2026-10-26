import { realpath } from 'node:fs/promises';
import * as path from 'node:path';

export class ToolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * Resolves a tool's path argument to an absolute path inside the workspace. Relative paths are
 * taken from the workspace root. Symlinks are followed for whatever part of the path exists, so
 * a link inside the workspace cannot be used to reach files outside it.
 */
export async function resolveInWorkspace(root: string, requested: string): Promise<string> {
  if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0')) throw new ToolError('A file path is required.');
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, requested.trim());
  const resolved = await realpathOfExistingPrefix(absolute);
  if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
    throw new ToolError(`${requested} is outside the workspace. Tools can only use files under ${realRoot}.`);
  }
  return resolved;
}

export function displayPath(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : absolute;
}

async function realpathOfExistingPrefix(absolute: string): Promise<string> {
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
