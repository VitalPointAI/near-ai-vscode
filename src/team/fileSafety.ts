import { lstat, open } from 'node:fs/promises';
import * as path from 'node:path';

// A file system that cannot sync a folder answers with one of these; the rename it follows still happened, so they are not errors here.
const FOLDER_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF']);

/** For tests only: runs after each folder sync with the folder synced, so a test can see the order of syncs. */
export type FolderSyncProbe = (dir: string) => Promise<void> | void;
let folderSyncProbe: FolderSyncProbe | undefined;
export function setFolderSyncProbe(next: FolderSyncProbe | undefined): void { folderSyncProbe = next; }

/**
 * Makes a rename (or a new file) in `dir` survive a power cut by syncing the folder itself (32-CONTEXT D-06). The one copy for the whole extension.
 * Windows has no folder sync, so there it only runs the test probe. A file system that cannot sync a folder is ignored; any other error is thrown.
 */
export async function syncFolder(dir: string): Promise<void> {
  if (process.platform !== 'win32') {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(dir, 'r');
      await handle.sync();
    } catch (error) {
      if (!FOLDER_SYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    } finally {
      await handle?.close();
    }
  }
  await folderSyncProbe?.(dir);
}

/**
 * Why a file may not be trusted as this user's private file, or undefined when it may. A link, anything that is not a regular file and a parent folder
 * that is a link are refused everywhere. On POSIX the file and its folder must also belong to the user running the editor, and the file must have no
 * group or other permission bits (a file written by this extension is mode 0600, so another editor of the same user passes). A short reason, never a path.
 */
export async function privateFileProblem(file: string): Promise<string | undefined> {
  let info;
  let parent;
  try {
    info = await lstat(file);
    parent = await lstat(path.dirname(file));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  if (info.isSymbolicLink()) return 'a link';
  if (!info.isFile()) return 'not a regular file';
  if (parent.isSymbolicLink() || !parent.isDirectory()) return 'its folder is a link';
  if (typeof process.getuid === 'function') {
    const me = process.getuid();
    if (info.uid !== me) return 'owned by someone else';
    if (parent.uid !== me) return 'its folder is owned by someone else';
    if ((info.mode & 0o077) !== 0) return 'readable by others';
  }
  return undefined;
}
