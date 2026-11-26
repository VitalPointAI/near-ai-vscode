import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { HEADER_MAX_BYTES, INLINE_BODY_MAX_BYTES, SEALED_OVERHEAD } from '../../domain/replica/entry';

// The longest line the store writes (store.ts): a header, the longest inline body as base64url, and room for the JSON around them. A longer line is
// not an entry, and it is skipped without being held whole.
const ROSTER_LINE_MAX_BYTES = HEADER_MAX_BYTES + Math.ceil(((INLINE_BODY_MAX_BYTES + SEALED_OVERHEAD + 3) * 4) / 3) + 1024;
const ROSTER_READ_CHUNK = 64 * 1024;

/**
 * Calls `take` with each whole line of one line file, read in chunks, until it returns true. A line longer than ROSTER_LINE_MAX_BYTES is skipped and
 * bytes after the last newline are left, as the store does. A file that is a link or not a plain file, or cannot be read, gives no lines.
 */
export async function eachRosterLine(file: string, take: (line: string) => boolean): Promise<void> {
  let handle: FileHandle;
  try {
    if (!(await lstat(file)).isFile()) return;
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return;
  }
  try {
    if (!(await handle.stat()).isFile()) return;
    const chunk = Buffer.allocUnsafe(ROSTER_READ_CHUNK);
    let pending: Buffer[] = [];
    let pendingLength = 0;
    let overlong = false;
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, ROSTER_READ_CHUNK, position);
      if (bytesRead === 0) return;
      position += bytesRead;
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(10, start);
        if (newline === -1 || newline >= bytesRead) break;
        const whole = !overlong && pendingLength + (newline - start) <= ROSTER_LINE_MAX_BYTES;
        const line = whole ? Buffer.concat([...pending, chunk.subarray(start, newline)]).toString('utf8') : undefined;
        pending = [];
        pendingLength = 0;
        overlong = false;
        start = newline + 1;
        if (line !== undefined && take(line)) return;
      }
      if (start < bytesRead && !overlong) {
        pendingLength += bytesRead - start;
        if (pendingLength > ROSTER_LINE_MAX_BYTES) { overlong = true; pending = []; } else pending.push(Buffer.from(chunk.subarray(start, bytesRead)));
      }
    }
  } catch {
    return;
  } finally {
    await handle.close();
  }
}
