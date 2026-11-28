import { OFFICE_ARCHIVE_LIMITS, openArchive, writeZip as writeArchive } from '../domain/archive/zip';
import { ToolError } from './workspace';

// The Office tools' view of the one archive reader in src/domain/archive/zip.ts (45.2-14, D-31): entries read on demand within a budget on what is
// read (against zip bombs), and archives written back. The reading, the checks and the writing live in the domain; this layer keeps the tools'
// signatures and turns a refusal into the ToolError they have always raised.

export const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;

/** The entries of a zip archive in order, each inflated on demand within a shared size budget. */
export function readZip(bytes: Buffer, name: string, maxUnpacked = MAX_UNPACKED_BYTES): Map<string, () => Buffer> {
  const archive = openArchive(bytes, OFFICE_ARCHIVE_LIMITS);
  if (!archive.ok) throw new ToolError(`${name} is not a valid Office file.`);
  const megabytes = Math.round(maxUnpacked / 1024 / 1024);
  const entries = new Map<string, () => Buffer>();
  let budget = maxUnpacked;
  for (const entry of archive.entries) {
    let cached: Buffer | undefined;
    entries.set(entry.name, () => {
      if (cached) return cached;
      // The declared size is checked before anything is unpacked; the reader then holds the entry to that size.
      if (entry.size > budget) throw new ToolError(`${name} is too large when unpacked (over ${megabytes} MB).`);
      const read = archive.read(entry.name);
      if (!read.ok) throw new ToolError(`${name} is too large when unpacked (over ${megabytes} MB) or damaged.`);
      budget -= read.bytes.length;
      cached = read.bytes;
      return read.bytes;
    });
  }
  return entries;
}

/** A zip archive of the given entries, in order, deflated. */
export function writeZip(entries: Array<[string, Buffer]>): Buffer {
  return writeArchive(entries);
}
