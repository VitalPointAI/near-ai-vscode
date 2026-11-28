// The two rules every staff writer and reader keeps for files that members can also write (review rounds 2 and 4 of drop 1). Node I/O only.
//
// - Unreadable is never empty: a file that is there but cannot be read whole (over the size limit, or refused by the disk) is reported with the reason,
//   never read as empty (readWhole).
// - The host never overwrites bytes it did not read: every host write to such a file is a compare-and-swap (writeIfUnchanged). The new text goes to a
//   temporary file, the target's hash is checked again against the bytes the host read, immediately before the atomic rename, and on any difference
//   nothing is written: the member's write stands, and it shows as the next edit. Members' Write and Edit take no lock, so a lock cannot give this; an
//   invariant on the host's side does.
import { createHash, randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { syncFolder } from '../team/fileSafety';

export { setFolderSyncProbe, syncFolder } from '../team/fileSafety';
export type { FolderSyncProbe } from '../team/fileSafety';

/** The most a staff file may hold to be read at all. */
export const MAX_STAFF_FILE_BYTES = 2 * 1024 * 1024;

export type WholeRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'text'; readonly text: string; readonly bytes: Buffer }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** A file read whole, or why not. `max` is the size limit (2 MB unless a store sets its own, such as the observation store's 8 MB segments). */
export async function readWhole(file: string, max: number = MAX_STAFF_FILE_BYTES): Promise<WholeRead> {
  let size: number;
  try { size = (await stat(file)).size; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', reason: `it could not be opened (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  if (size > max) return { kind: 'unreadable', reason: `it is larger than ${Math.round(max / (1024 * 1024))} MB` };
  try {
    const bytes = await readFile(file);
    return { kind: 'text', text: bytes.toString('utf8'), bytes };
  } catch (error) {
    return { kind: 'unreadable', reason: `it could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
  }
}

/** What the host read of a file: absent, or the hash of the exact bytes. */
export type FileSnapshot = { readonly exists: false } | { readonly exists: true; readonly hash: string };

export function snapshotOfBytes(bytes: Buffer | undefined): FileSnapshot {
  return bytes === undefined ? { exists: false } : { exists: true, hash: createHash('sha256').update(bytes).digest('hex') };
}

/** The file's snapshot now; a file that cannot be read gets a snapshot no read can match, so no write goes over it. */
export async function snapshotOf(file: string): Promise<FileSnapshot> {
  try { return snapshotOfBytes(await readFile(file)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    return { exists: true, hash: `unreadable:${randomBytes(8).toString('hex')}` };
  }
}

function same(a: FileSnapshot, b: FileSnapshot): boolean {
  return a.exists === b.exists && (!a.exists || (b.exists && a.hash === b.hash));
}

/** For tests only: runs at each point a member's write could land, so a test can put one there. */
export interface CasProbe { (point: 'before-temp' | 'before-check' | 'before-rename' | 'after-aside' | 'after-install', file: string): Promise<void> | void }
let probe: CasProbe | undefined;
export function setCasProbe(next: CasProbe | undefined): void { probe = next; }

/**
 * Writes `text` to `file` only if the file is still exactly what the host read (`expected`). Returns false, writing nothing, when it changed: the caller
 * leaves its change pending. `text` undefined removes the file, under the same check. When a scope guard is passed, check it immediately before
 * staging and again in the same turn as the final mutation, after the last awaited check.
 */
export async function writeIfUnchanged(file: string, expected: FileSnapshot, text: string | undefined, verifyBeforeEffect?: () => boolean): Promise<boolean> {
  await probe?.('before-temp', file);
  if (text === undefined) {
    await probe?.('before-check', file);
    if (!same(await snapshotOf(file), expected)) return false;
    await probe?.('before-rename', file);
    if (!same(await snapshotOf(file), expected)) return false;
    if (verifyBeforeEffect) {
      if (!verifyBeforeEffect()) return false;
      rmSync(file, { force: true });
    } else {
      await rm(file, { force: true });
    }
    return true;
  }
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  if (verifyBeforeEffect) {
    if (!verifyBeforeEffect()) return false;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' });
  } else {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
  }
  try {
    await probe?.('before-check', file);
    if (!same(await snapshotOf(file), expected)) { await rm(temporary, { force: true }); return false; }
    await probe?.('before-rename', file);
    // Checked again immediately before the rename: the window left is the rename itself.
    if (!same(await snapshotOf(file), expected) || (verifyBeforeEffect && !verifyBeforeEffect())) {
      await rm(temporary, { force: true });
      return false;
    }
    if (verifyBeforeEffect) renameSync(temporary, file);
    else await rename(temporary, file);
    return true;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** What replaceKeepingEdits did: wrote, found the file changed before it began, or met a write that landed while it ran (`kept` names a copy it left). */
export type KeptReplace = { readonly status: 'written' | 'changed' } | { readonly status: 'raced'; readonly kept?: string };

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/**
 * writeIfUnchanged without the window before its rename (33-06): a write that lands at any point is never replaced. The current file is moved aside
 * first (so whatever is at the path at that moment is held, never replaced), its bytes are compared, and the new text is linked into place only where
 * no file is (a link never replaces one). Afterwards the held copy is compared again; a copy that still holds what the caller read is removed, and one
 * that changed (written through a handle opened before the move) is put back over the new text, or kept beside it and named when the new text changed
 * too. A missing file is created only where none is. The path is briefly absent while the old file is aside.
 */
export async function replaceKeepingEdits(file: string, expected: FileSnapshot, text: string, verifyBeforeAbsentLink?: () => boolean): Promise<KeptReplace> {
  await mkdir(path.dirname(file), { recursive: true });
  const suffix = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const temporary = `${file}.${suffix}.tmp`;
  await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
  try {
    await probe?.('before-check', file);
    // An object at an expected-absent target is a conflict even if it is a dangling link.
    const unchanged = expected.exists
      ? same(await snapshotOf(file), expected)
      : await lstat(file).then(() => false, (error: unknown) => errnoOf(error) === 'ENOENT');
    if (!unchanged) return { status: 'changed' };
    await probe?.('before-rename', file);
    let aside: string | undefined;
    if (expected.exists) {
      aside = `${file}.${suffix}.aside`;
      try { await rename(file, aside); } catch (error) {
        if (errnoOf(error) === 'ENOENT') return { status: 'raced' };
        throw error;
      }
      await probe?.('after-aside', file);
      if (!same(await snapshotOf(aside), expected)) {
        // Another write replaced the file before it was moved: that write is what was moved, so it goes back where it was.
        try { await link(aside, file); } catch (error) {
          if (errnoOf(error) === 'EEXIST') return { status: 'raced', kept: aside };
          throw error;
        }
        await rm(aside, { force: true });
        return { status: 'raced' };
      }
    }
    try {
      if (!expected.exists && verifyBeforeAbsentLink) {
        // The isolated fixture holds its parent directories. Its current
        // authority check and the no-replacement effect share this turn.
        if (!verifyBeforeAbsentLink()) return { status: 'changed' };
        linkSync(temporary, file);
      } else await link(temporary, file);
    } catch (error) {
      if (errnoOf(error) !== 'EEXIST') throw error;
      // A new file appeared where the old one was: it stands, and the held copy is the text the caller read.
      if (aside !== undefined) await rm(aside, { force: true });
      return { status: 'raced' };
    }
    await probe?.('after-install', file);
    if (aside === undefined || same(await snapshotOf(aside), expected)) {
      if (aside !== undefined) await rm(aside, { force: true });
      return { status: 'written' };
    }
    // The held copy changed after the move. It goes back over the new text, unless the new text changed as well: then both stay.
    if (same(await snapshotOf(file), snapshotOfBytes(Buffer.from(text, 'utf8')))) {
      await rename(aside, file);
      return { status: 'raced' };
    }
    return { status: 'raced', kept: aside };
  } finally {
    await rm(temporary, { force: true });
  }
}
