import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Logger } from './log/logger';

// The relay's one private state directory (D-07, D-17). Everything the relay keeps lives here: the database and, in later phases, secrets the
// relay generates itself. Rules, all fail-closed:
//  - a missing directory is created 0700 (chmod, so the result does not depend on the umask);
//  - a directory or entry that is a symbolic link, is not what it should be, or belongs to another user stops startup with a plain reason;
//  - a directory or file that the relay's own user owns but that is open to group or world is tightened (0700 / 0600) and logged once.
//    This only ever removes access, so it keeps the intent of D-07 while letting a fresh Podman volume (created 0755) start (Open Question 1).

export class StateDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateDirError';
  }
}

export interface PrepareOptions {
  /** The uid the relay runs as. Defaults to process.getuid(); tests pass a different value to prove the refusal. */
  uid?: number;
}

const GROUP_OR_WORLD = 0o077;
/** What writePrivateFileAtomic names its temporary file: a dot, the target name, 8 lowercase hex characters, .tmp. */
const OWN_TEMP_FILE = /^\..+\.[0-9a-f]{8}\.tmp$/;
/** The folder mkfs puts at the root of an ext2/3/4 file system, owned by root. A state directory that is a mount point holds one. */
const LOST_AND_FOUND = 'lost+found';

function octal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

function currentUid(options?: PrepareOptions): number {
  const uid = options?.uid ?? process.getuid?.();
  if (uid === undefined) throw new StateDirError('RELAY_STATE_DIR cannot be checked on this platform: the relay needs to know its own user id.');
  return uid;
}

export async function prepareStateDir(dir: string, logger: Logger, options?: PrepareOptions): Promise<void> {
  const uid = currentUid(options);

  let info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new StateDirError(`RELAY_STATE_DIR ${dir} cannot be read (${error.code ?? 'error'}). Choose a directory the relay's user can reach.`);
  });
  if (info === undefined) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    info = await lstat(dir);
  }

  if (info.isSymbolicLink()) {
    throw new StateDirError(`RELAY_STATE_DIR ${dir} is a symbolic link. Point RELAY_STATE_DIR at the real directory instead.`);
  }
  if (!info.isDirectory()) {
    throw new StateDirError(`RELAY_STATE_DIR ${dir} is not a directory. Choose a directory, or a path that does not exist yet.`);
  }
  if (info.uid !== uid) {
    throw new StateDirError(
      `RELAY_STATE_DIR ${dir} is owned by uid ${info.uid}; the relay runs as uid ${uid}. Give the directory to the relay's user or choose another directory.`,
    );
  }
  if ((info.mode & GROUP_OR_WORLD) !== 0) {
    const fromMode = octal(info.mode);
    await chmod(dir, 0o700);
    const after = await lstat(dir);
    if (!after.isDirectory() || after.uid !== uid || (after.mode & GROUP_OR_WORLD) !== 0) {
      throw new StateDirError(`RELAY_STATE_DIR ${dir} is open to other users and could not be made private. Run chmod 700 on it as its owner.`);
    }
    logger.info('state_dir.tightened', { fromMode });
  }

  for (const name of await readdir(dir)) {
    const entryPath = path.join(dir, name);
    const entry = await lstat(entryPath);
    if (entry.isSymbolicLink()) {
      throw new StateDirError(`RELAY_STATE_DIR ${dir} holds a symbolic link (${name}). Remove it or choose another directory.`);
    }
    // A state directory that is the mount point of its own volume holds the file system's lost+found folder, owned by root, which the operator
    // cannot remove. The relay never reads or writes it, so exactly that name, as a real folder, is left alone: not checked, not tightened.
    if (name === LOST_AND_FOUND && entry.isDirectory()) continue;
    if (entry.uid !== uid) {
      throw new StateDirError(
        `RELAY_STATE_DIR ${dir} holds ${name}, which is owned by uid ${entry.uid}; the relay runs as uid ${uid}. Give it to the relay's user or choose another directory.`,
      );
    }
    if (entry.isFile() && OWN_TEMP_FILE.test(name)) {
      // A temporary file of writePrivateFileAtomic that a kill left behind between open and rename. It may hold a copy of a key, and the
      // complete file is either the old or the new one under its real name, so the leftover is removed.
      await rm(entryPath, { force: true });
      logger.info('state_dir.stale_temp_removed', { name });
      continue;
    }
    if (entry.isFile()) {
      if ((entry.mode & GROUP_OR_WORLD) !== 0) {
        const fromMode = octal(entry.mode);
        await chmod(entryPath, 0o600);
        logger.info('state_dir.file_tightened', { name, fromMode });
      }
    } else if (entry.isDirectory()) {
      // Later phases may keep a folder per tenant here. It is tightened but not searched.
      if ((entry.mode & GROUP_OR_WORLD) !== 0) {
        const fromMode = octal(entry.mode);
        await chmod(entryPath, 0o700);
        logger.info('state_dir.file_tightened', { name, fromMode });
      }
    } else {
      throw new StateDirError(`RELAY_STATE_DIR ${dir} holds ${name}, which is neither a file nor a folder. Remove it or choose another directory.`);
    }
  }
}

function plainName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name !== path.basename(name) || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new StateDirError('A state file name must be a plain file name without folders.');
  }
}

async function syncDirectory(dir: string): Promise<void> {
  // fsync of the directory makes the rename itself durable, not only the file's bytes.
  const handle = await open(dir, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Writes data to dir/name so a reader sees the old file or the new one, never half of it: temp file 0600, fsync, rename, fsync the directory. */
export async function writePrivateFileAtomic(dir: string, name: string, data: string | Buffer): Promise<void> {
  plainName(name);
  const target = path.join(dir, name);
  const temporary = path.join(dir, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync(); // fsync before the rename, so the new name never points at bytes that are not on disk
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await syncDirectory(dir);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Reads dir/name, or undefined when it does not exist. Refuses a symbolic link and anything not a plain file owned by the relay with no group or
 * world access. The relay's uid comes from the same option as prepareStateDir, so the two checks always agree.
 */
export async function readPrivateFile(dir: string, name: string, options?: PrepareOptions): Promise<Buffer | undefined> {
  plainName(name);
  const uid = currentUid(options);
  const file = path.join(dir, name);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') throw new StateDirError(`The state file ${name} in ${dir} is a symbolic link and was not read.`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new StateDirError(`The state file ${name} in ${dir} is not a regular file and was not read.`);
    if (info.uid !== uid) throw new StateDirError(`The state file ${name} in ${dir} is owned by another user and was not read.`);
    if ((info.mode & GROUP_OR_WORLD) !== 0) {
      throw new StateDirError(`The state file ${name} in ${dir} is open to other users (mode ${octal(info.mode)}) and was not read. Run chmod 600 on it as its owner.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
