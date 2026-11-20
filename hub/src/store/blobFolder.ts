// The hub's content-addressed blob folder (D-44; DESIGN 10.3): <state>/blobs/<project>/<hash>, one file per sealed blob, named by the sha256 of
// its bytes. Files are 0600 in 0700 folders and a symbolic link anywhere in the folder is refused, never followed.
//
// A blob file is written the way stateDir.ts writePrivateFileAtomic writes (copied from relay/src/stateDir.ts): a temporary file named
// .<hash>.<8 hex>.tmp, fsync, rename to its name, fsync of the folder, so a reader sees the whole file or none. The store writes the file before
// its row, so a crash can leave a file with no row (removed at the next open by sweepOrphans) and never a row with no file.
import { randomBytes } from 'node:crypto';
import { chmodSync, constants, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { HASH_PATTERN, STREAM_ID_PATTERN } from '@ext/domain/replica/entry';
import { StoreError } from './schema';

/** What writeBlobFile names its temporary file: a dot, the blob hash, 8 lowercase hex characters, .tmp. */
export const BLOB_TEMP_FILE = /^\.[0-9a-f]{64}\.[0-9a-f]{8}\.tmp$/;

function damaged(): StoreError {
  return new StoreError('damaged-store', 'The blob folder holds something the hub did not write there (a link or an unexpected folder).');
}

function names(project: string, hash: string): void {
  // The store checks both before it calls in here; this is the folder's own guard against a path built from anything else.
  if (!STREAM_ID_PATTERN.test(project) || !HASH_PATTERN.test(hash)) throw new StoreError('invalid-record');
}

/** A real folder, never a link, created 0700 when missing. Returns true when this call created it. */
function ensureFolder(folder: string): boolean {
  let created = false;
  try {
    mkdirSync(folder, { mode: 0o700 });
    chmodSync(folder, 0o700); // mkdir's mode is cut by the umask; chmod makes it exact
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = lstatSync(folder);
  if (info.isSymbolicLink() || !info.isDirectory()) throw damaged();
  return created;
}

/** False when the folder is not there; refuses a link or a non-folder, so no read or unlink ever goes through a link in the path. */
function realFolder(folder: string): boolean {
  let info;
  try {
    info = lstatSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw damaged();
  return true;
}

/** fsync of a folder makes a rename or an unlink in it durable, not only the file's bytes. */
export async function syncFolder(folder: string): Promise<void> {
  const handle = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Writes one blob file: temporary file 0600, fsync, rename, fsync the folder (and the root when the project folder is new). */
export async function writeBlobFile(root: string, project: string, hash: string, bytes: Buffer): Promise<void> {
  names(project, hash);
  ensureFolder(root);
  const folder = path.join(root, project);
  const created = ensureFolder(folder);
  if (created) await syncFolder(root);
  const temporary = path.join(folder, `.${hash}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    // wx is O_CREAT | O_EXCL, which never follows a link at the final name.
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync(); // before the rename, so the name never points at bytes that are not on disk
    } finally {
      await handle.close();
    }
    // The folder is checked again just before the rename, so a link swapped in while the bytes were written is refused.
    realFolder(folder);
    await rename(temporary, path.join(folder, hash));
    await syncFolder(folder);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The bytes of one blob file, or undefined when there is no file. Refuses a link and anything that is not a regular file. */
export async function readBlobFile(root: string, project: string, hash: string): Promise<Buffer | undefined> {
  names(project, hash);
  if (!realFolder(root) || !realFolder(path.join(root, project))) return undefined;
  let handle;
  try {
    handle = await open(path.join(root, project, hash), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP' || code === 'ENOTDIR') throw damaged();
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw damaged();
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Removes one blob file at once (synchronously, so nothing else runs between the store's row delete and this). False when it was not there. */
export function removeBlobFile(root: string, project: string, hash: string): boolean {
  names(project, hash);
  if (!realFolder(root) || !realFolder(path.join(root, project))) return false;
  try {
    unlinkSync(path.join(root, project, hash));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export interface OrphanSweep {
  /** Blob files with no row, removed. */
  orphans: number;
  /** Temporary files a kill left behind, removed. */
  temporary: number;
  /** For each project folder, how many blob files with a row were found. The store compares this with its row counts to find missing files. */
  found: Map<string, number>;
}

/**
 * Runs at open, before anything else touches the folder. Removes every file the store does not know (a blob file with no row, a stale temporary
 * file, any other plain file) and counts the known files per project. A link, or a folder where only blob files belong, is refused: the hub
 * never wrote one, so it stops rather than guess.
 */
export async function sweepOrphans(root: string, isKnown: (project: string, hash: string) => boolean): Promise<OrphanSweep> {
  const result: OrphanSweep = { orphans: 0, temporary: 0, found: new Map() };
  for (const top of await readdir(root, { withFileTypes: true })) {
    const topPath = path.join(root, top.name);
    if (top.isSymbolicLink()) throw damaged();
    if (top.isFile()) {
      await rm(topPath, { force: true });
      result.orphans += 1;
      continue;
    }
    if (!top.isDirectory() || !STREAM_ID_PATTERN.test(top.name)) throw damaged();
    const project = top.name;
    let found = 0;
    let touched = false;
    for (const item of await readdir(topPath, { withFileTypes: true })) {
      if (!item.isFile()) throw damaged();
      const itemPath = path.join(topPath, item.name);
      if (BLOB_TEMP_FILE.test(item.name)) {
        await rm(itemPath, { force: true });
        result.temporary += 1;
        touched = true;
      } else if (HASH_PATTERN.test(item.name) && isKnown(project, item.name)) {
        found += 1;
      } else {
        await rm(itemPath, { force: true });
        result.orphans += 1;
        touched = true;
      }
    }
    if (touched) await syncFolder(topPath);
    result.found.set(project, found);
  }
  return result;
}
