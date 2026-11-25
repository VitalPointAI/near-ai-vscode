import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rename } from 'node:fs/promises';
import * as path from 'node:path';
import { HASH_PATTERN, STREAM_ID_PATTERN } from '../../domain/replica/entry';
import { syncFolder } from '../staffFiles';

interface Counts { carried: number; grants: number; blobs: number }

async function pathInfo(file: string) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('A recovery path is a symbolic link.');
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  const info = await pathInfo(dir);
  if (info && !info.isDirectory()) throw new Error('A recovery folder is not a directory.');
  return info !== undefined;
}

async function plainFile(file: string): Promise<boolean> {
  const info = await pathInfo(file);
  if (info && !info.isFile()) throw new Error('A recovery file is not a plain file.');
  return info !== undefined;
}

async function list(dir: string): Promise<string[]> {
  return (await directoryExists(dir)) ? readdir(dir) : [];
}

/** Only complete records count. The store ignores a cut tail after the last newline. */
async function countLines(file: string): Promise<number> {
  if (!(await plainFile(file))) return 0;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count = 0;
    let haveText = false;
    for (;;) {
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) return count;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] === 10) {
          if (haveText) count += 1;
          haveText = false;
        } else haveText = true;
      }
    }
  } finally {
    await handle.close();
  }
}

/** Count just the files and complete own lines that the rebuild writes. */
export async function countFolder(folder: string, writer: string): Promise<Counts> {
  const streams = path.join(folder, 'streams');
  const grants = path.join(folder, 'grants');
  const blobs = path.join(folder, 'blobs');
  const counts = { carried: 0, grants: 0, blobs: 0 };
  for (const stream of await list(streams)) {
    const dir = path.join(streams, stream);
    if (STREAM_ID_PATTERN.test(stream) && await directoryExists(dir)) counts.carried += await countLines(path.join(dir, `${writer}.jsonl`));
  }
  for (const cell of await list(grants)) {
    if (!STREAM_ID_PATTERN.test(cell)) continue;
    const dir = path.join(grants, cell);
    for (const name of await list(dir)) {
      if (/^[1-9][0-9]{0,15}-[0-9a-f]{64}\.json$/.test(name) && await plainFile(path.join(dir, name))) counts.grants += 1;
    }
  }
  for (const name of await list(blobs)) {
    if (HASH_PATTERN.test(name) && await plainFile(path.join(blobs, name))) counts.blobs += 1;
  }
  return counts;
}

export function countsMatch(counts: Counts, intent: Counts): boolean {
  return counts.carried === intent.carried && counts.grants === intent.grants && counts.blobs === intent.blobs;
}

async function matchesText(file: string, text: string): Promise<boolean> {
  if (!(await plainFile(file))) return false;
  const expected = Buffer.from(text);
  const bytes = Buffer.alloc(expected.length + 1);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const { bytesRead } = await handle.read(bytes);
    return bytesRead === expected.length && bytes.subarray(0, bytesRead).equals(expected);
  } finally {
    await handle.close();
  }
}

/** Keep a partial folder beside the store, then rebuild from the recorded source. */
export async function moveInChecked({ temporary, dir, staff, source, intent, completedIgnore, rebuild }: {
  temporary: string; dir: string; staff: string; source?: string; intent: Counts & { writer: string }; completedIgnore: string; rebuild: () => Promise<void>;
}): Promise<void> {
  const projectFile = 'project.json';
  // Older builds wrote the finished ignore file first. Check that their project pin was copied as well.
  const needsPin = source !== undefined && await directoryExists(source) && await plainFile(path.join(source, projectFile));
  const ready = async (): Promise<boolean> =>
    (await matchesText(path.join(temporary, '.gitignore'), completedIgnore)) &&
    (!needsPin || await plainFile(path.join(temporary, projectFile))) &&
    countsMatch(await countFolder(temporary, intent.writer), intent);
  const exists = await directoryExists(temporary);
  if (!exists || !(await ready())) {
    if (exists) {
      await rename(temporary, path.join(staff, `replica.incomplete-${randomBytes(12).toString('hex')}`));
      await syncFolder(staff);
    }
    await rebuild();
    await syncFolder(temporary);
    if (!(await ready())) throw new Error('The rebuilt store does not match the recovery record.');
  }
  await rename(temporary, dir);
  await syncFolder(staff);
}
