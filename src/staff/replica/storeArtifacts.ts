import { lstat } from 'node:fs/promises';
import { readWhole } from '../staffFiles';

/** Read an immutable, size-limited JSON artifact and verify the identity encoded by its name. */
export async function readStoredArtifact(file: string, maxBytes: number, matches: (value: unknown) => boolean): Promise<{ value: unknown } | { reason: string }> {
  try {
    if ((await lstat(file)).isSymbolicLink()) return { reason: 'it is a symbolic link' };
  } catch {
    return { reason: 'it could not be opened' };
  }
  const read = await readWhole(file, maxBytes);
  if (read.kind === 'missing') return { reason: 'it is gone' };
  if (read.kind === 'unreadable') return { reason: read.reason };
  let value: unknown;
  try { value = JSON.parse(read.text) as unknown; } catch { return { reason: 'it is not readable JSON' }; }
  try {
    return matches(value) ? { value } : { reason: 'its content does not match its name' };
  } catch {
    return { reason: 'its content does not match its name' };
  }
}
