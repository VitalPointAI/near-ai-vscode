import * as path from 'node:path';
import { sha256Hex } from '../../domain/replica/entry';
import { canonicalBytes } from '../../domain/team/canonical';
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

export async function readHashedArtifacts(dir: string, names: readonly string[], maxBytes: number): Promise<Array<{ hash: string; value: unknown }>> {
  const rows: Array<{ hash: string; value: unknown }> = [];
  for (const name of names) {
    const hash = /^([0-9a-f]{64})\.json$/.exec(name)?.[1];
    if (hash === undefined) continue;
    const read = await readStoredArtifact(path.join(dir, name), maxBytes, (value) => sha256Hex(canonicalBytes(value)) === hash);
    if ('value' in read) rows.push({ hash, value: read.value });
  }
  return rows;
}
