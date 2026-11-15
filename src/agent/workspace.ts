import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { STATE_KEYS_PATH, stateKeysReason } from '../domain/protectedPaths';

export class ToolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** A path that resolves into the project's key folder, which no agent tool may use (0.4.23). */
export class StateKeysError extends ToolError {}

/**
 * Resolves a tool's path argument to an absolute path inside the workspace. Relative paths are
 * taken from the workspace root. Symlinks are followed for whatever part of the path exists, so
 * a link inside the workspace cannot be used to reach files outside it.
 */
export async function resolveInWorkspace(root: string, requested: string, readOnlyRoots: string[] = []): Promise<string> {
  if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0')) throw new ToolError('A file path is required.');
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, requested.trim());
  const resolved = await realpathOfExistingPrefix(absolute);
  const within = (base: string) => resolved === base || resolved.startsWith(base + path.sep);
  // The project's key folder is never an agent tool's file (0.4.23), however it was reached: every file tool resolves its path here.
  if (STATE_KEYS_PATH.test(resolved.split(path.sep).join('/'))) throw new StateKeysError(stateKeysReason(requested));
  if (within(realRoot)) return resolved;
  // Extra roots (the Open-GSD runtime) can be read but are never passed for writes.
  for (const extra of readOnlyRoots) if (within(await realpath(extra).catch(() => extra))) return resolved;
  throw new ToolError(`${requested} is outside the workspace. Tools can only use files under ${realRoot}.`);
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
      // A link whose target is missing would be followed by a later write; refuse it.
      if (await lstat(current).then((info) => info.isSymbolicLink(), () => false)) throw new ToolError(`${current} is a symbolic link to a missing target, so it can't be used safely.`);
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
