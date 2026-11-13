// Cross-process locks for one project's state folder, kept in <project>/.near-ai/locks. Two editors on one computer share the project folder, so
// two extension hosts can change meta.json, create the key or sync at the same moment; a lock file here gives each of those one owner at a time.
// The folder is created owner-only and its own .gitignore (holding '*') is written before anything else, so no lock file is ever staged.
//
// Lock names and their order: 'sync' (a whole sync) and 'meta' (meta.json and key creation). A holder of 'sync' may take 'meta' inside it; a
// holder of 'meta' never takes 'sync'. The locks are not re-entrant: work inside 'meta' must not call anything that takes 'meta' again
// (use ProjectStateHome.updateMetaHeld there, never updateMeta). No vscode here, so tests run on plain node.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { withFileLock, type MirrorLockOptions } from './stateMirrorLock';

export const STATE_LOCKS_DIR = '.near-ai/locks';
export type StateLockName = 'sync' | 'meta';

const IGNORE_ALL = '*\n';

export class StateBusyError extends Error {
  public constructor() {
    super("Another editor on this computer is saving this project's state. Try again in a moment. Nothing was changed.");
    this.name = 'StateBusyError';
  }
}

// Creates the .gitignore with an exclusive create (never replaces one); a local helper so this module does not import stateHome.ts.
async function writeIgnoreFirst(file: string): Promise<void> {
  try {
    await writeFile(file, IGNORE_ALL, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Runs `work` while holding the named lock for the project at `root`, in this process and across processes. Throws StateBusyError after the wait limit. */
export async function withStateLock<T>(root: string, name: StateLockName, work: () => Promise<T>, options: Partial<MirrorLockOptions> = {}): Promise<T> {
  const dir = path.join(path.resolve(root), STATE_LOCKS_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  await writeIgnoreFirst(path.join(dir, '.gitignore'));
  return withFileLock(dir, `${name}.lock`, work, { ...options, busy: () => new StateBusyError() });
}
