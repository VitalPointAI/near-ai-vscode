// The one ZIP reader and writer (45.2-14, CONTEXT D-31). Everything that arrives as a ZIP container is read here: partners' TDF objects, Office
// documents and OPC packages, and the Office tools' own files through the thin layer in src/agent/zip.ts. Pure apart from node:zlib: no file system,
// no network, no clock (the architecture test refuses any I/O module in this folder).
//
// Hostile input is refused as data, never as an exception, and before more is unpacked than must be. From the central directory alone, before any
// entry is inflated: a damaged or truncated directory, a split archive, ZIP64, more entries than the limit, duplicate names, absolute,
// parent-relative, backslashed or drive-letter names, encrypted entries, compression methods other than stored and deflate, an entry declared larger
// than the per-entry limit, a declared ratio above the limit, and a declared total above the limit. When an entry is read: its local header must
// match its directory record, the output cap passed to the inflater is the declared size (so a zip bomb that lies about its size stops there), and
// the bytes must match the declared size and CRC-32. The checks follow the release gate's strict reader (scripts/lib/zip.mjs) and the published
// approaches of hostile-archive readers (45.2-RESEARCH section 12.4); no code was taken from them.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/** What an archive may hold. Sizes and the ratio are checked on the directory's declared values, which the reader then holds every entry to. */
export interface ArchiveLimits {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxUnpackedBytes: number;
  /** The highest declared unpacked size over compressed size for one entry; undefined for no limit. */
  readonly maxRatio: number | undefined;
  /** Whether each entry's CRC-32 is checked. A CRC-32 proves no authorship; it catches damage, which matters for what a partner sends. */
  readonly checkCrc: boolean;
}

const MIB = 1024 * 1024;

/** Arrivals from partners (D-31): at most 4,096 entries, 256 MiB per entry, 512 MiB in total, and a ratio of 200 per entry. */
export const EXCHANGE_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({ maxEntries: 4096, maxEntryBytes: 256 * MIB, maxUnpackedBytes: 512 * MIB, maxRatio: 200, checkCrc: true });

/**
 * The Office tools, as they were before the reader moved here: only the limits of the format itself when the archive is opened, because the tools read
 * a few parts of a file that may also hold large pictures or video. Their 50 MiB budget is a budget on what they read, kept by readZip in
 * src/agent/zip.ts. CRC-32 is not checked, so a file Office itself opens still opens; the declared sizes are still enforced.
 */
export const OFFICE_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({ maxEntries: 0xffff, maxEntryBytes: 0xfffffffe, maxUnpackedBytes: Number.MAX_SAFE_INTEGER, maxRatio: undefined, checkCrc: false });

/** Every reason an archive or an entry is refused, each one plain sentence. */
export const ARCHIVE_REFUSALS = Object.freeze({
  'not-an-archive': 'This file is not a ZIP archive, or its end is missing.',
  'directory-damaged': "The archive's list of contents is damaged or cut short.",
  'split-archive': 'The archive is split across several files, which is not supported.',
  zip64: 'The archive uses ZIP64, which is not supported.',
  'too-many-entries': 'The archive holds more files than are allowed.',
  'duplicate-name': 'The archive holds two files with the same name.',
  'unsafe-name': 'The archive holds a file name that could point outside it.',
  encrypted: 'The archive holds an encrypted file, which is not supported.',
  'unsupported-method': 'The archive holds a file packed in a way that is not supported.',
  'entry-too-large': 'A file in the archive is larger than allowed when unpacked.',
  'ratio-too-high': 'A file in the archive unpacks to far more than its packed size, as a zip bomb does.',
  'total-too-large': 'The files in the archive are larger in total than allowed when unpacked.',
  'entry-damaged': 'A file in the archive is damaged.',
  'size-mismatch': 'A file in the archive does not unpack to the size its list of contents records.',
  'crc-mismatch': 'A file in the archive does not match the checksum its list of contents records.',
  'no-such-entry': 'The archive does not hold that file.'
} as const);

export type ArchiveRefusal = keyof typeof ARCHIVE_REFUSALS;

export interface ArchiveRefused { readonly ok: false; readonly reason: ArchiveRefusal; readonly message: string }
export interface ArchiveEntry { readonly name: string; readonly size: number; readonly compressedSize: number }
export type EntryRead = { readonly ok: true; readonly bytes: Buffer } | ArchiveRefused;
export interface OpenedArchive {
  readonly ok: true;
  /** The entries in central-directory order. */
  readonly entries: readonly ArchiveEntry[];
  /** One entry's bytes, checked against its declared size (and CRC-32 under limits that check it), or a refusal. */
  read(name: string): EntryRead;
}

const END_RECORD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END_RECORD = 0x06064b50;
const DIRECTORY_RECORD = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const END_LENGTH = 22;
const DIRECTORY_LENGTH = 46;
const LOCAL_LENGTH = 30;
const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED = 0x0001;
const STRONG_ENCRYPTION = 0x0040;
const ZIP64_MARK = 0xffffffff;

function refusal(reason: ArchiveRefusal): ArchiveRefused {
  return { ok: false, reason, message: ARCHIVE_REFUSALS[reason] };
}

/** A name that stays inside the archive's own folder: not empty, no leading slash, no backslash, no drive letter, no '..' segment, no NUL. */
function isSafeName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.includes('\\') || name.includes('\u0000') || /^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').includes('..');
}

/** The offset of the end record, searched back from the end past a comment whose length must reach the end exactly; -1 when there is none. */
function findEndRecord(bytes: Buffer): number {
  if (bytes.length < END_LENGTH) return -1;
  const lowest = Math.max(0, bytes.length - END_LENGTH - 0xffff);
  for (let offset = bytes.length - END_LENGTH; offset >= lowest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_RECORD && offset + END_LENGTH + bytes.readUInt16LE(offset + 20) === bytes.length) return offset;
  }
  return -1;
}

interface Record { flags: number; method: number; crc: number; compressedSize: number; size: number; localOffset: number }

/** Opens an archive under the given limits, or refuses it from its directory before anything is unpacked. */
export function openArchive(input: Uint8Array, limits: ArchiveLimits): OpenedArchive | ArchiveRefused {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const end = findEndRecord(bytes);
  if (end < 0) return refusal('not-an-archive');
  if (end >= 20 && (bytes.readUInt32LE(end - 20) === ZIP64_LOCATOR || bytes.readUInt32LE(end - 20) === ZIP64_END_RECORD)) return refusal('zip64');
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) return refusal('split-archive');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || bytes.readUInt16LE(end + 8) === 0xffff || directorySize === ZIP64_MARK || directoryOffset === ZIP64_MARK) return refusal('zip64');
  if (bytes.readUInt16LE(end + 8) !== count || directoryOffset + directorySize > end) return refusal('directory-damaged');
  if (count > limits.maxEntries) return refusal('too-many-entries');

  const records = new Map<string, Record>();
  const entries: ArchiveEntry[] = [];
  let total = 0;
  let offset = directoryOffset;
  const directoryEnd = directoryOffset + directorySize;
  while (offset < directoryEnd) {
    if (offset + DIRECTORY_LENGTH > directoryEnd || bytes.readUInt32LE(offset) !== DIRECTORY_RECORD) return refusal('directory-damaged');
    const nameLength = bytes.readUInt16LE(offset + 28);
    const next = offset + DIRECTORY_LENGTH + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (next > directoryEnd) return refusal('directory-damaged');
    if (entries.length >= count) return refusal('directory-damaged');
    const record: Record = {
      flags: bytes.readUInt16LE(offset + 8),
      method: bytes.readUInt16LE(offset + 10),
      crc: bytes.readUInt32LE(offset + 16),
      compressedSize: bytes.readUInt32LE(offset + 20),
      size: bytes.readUInt32LE(offset + 24),
      localOffset: bytes.readUInt32LE(offset + 42)
    };
    const name = bytes.toString('utf8', offset + DIRECTORY_LENGTH, offset + DIRECTORY_LENGTH + nameLength);
    offset = next;
    if (record.compressedSize === ZIP64_MARK || record.size === ZIP64_MARK || record.localOffset === ZIP64_MARK) return refusal('zip64');
    if (!isSafeName(name)) return refusal('unsafe-name');
    if (records.has(name)) return refusal('duplicate-name');
    if ((record.flags & (ENCRYPTED | STRONG_ENCRYPTION)) !== 0) return refusal('encrypted');
    if (record.method !== STORED && record.method !== DEFLATED) return refusal('unsupported-method');
    if (record.size > limits.maxEntryBytes) return refusal('entry-too-large');
    if (limits.maxRatio !== undefined && record.size > 0 && record.size > limits.maxRatio * Math.max(1, record.compressedSize)) return refusal('ratio-too-high');
    total += record.size;
    if (total > limits.maxUnpackedBytes) return refusal('total-too-large');
    records.set(name, record);
    entries.push(Object.freeze({ name, size: record.size, compressedSize: record.compressedSize }));
  }
  if (entries.length !== count) return refusal('directory-damaged');

  const read = (name: string): EntryRead => {
    const record = records.get(name);
    if (record === undefined) return refusal('no-such-entry');
    return readEntry(bytes, name, record, directoryOffset, limits.checkCrc);
  };
  return Object.freeze({ ok: true as const, entries: Object.freeze(entries), read });
}

function readEntry(bytes: Buffer, name: string, record: Record, directoryOffset: number, checkCrc: boolean): EntryRead {
  const at = record.localOffset;
  if (at + LOCAL_LENGTH > directoryOffset || bytes.readUInt32LE(at) !== LOCAL_HEADER) return refusal('entry-damaged');
  const nameLength = bytes.readUInt16LE(at + 26);
  const start = at + LOCAL_LENGTH + nameLength + bytes.readUInt16LE(at + 28);
  if (start + record.compressedSize > directoryOffset || bytes.toString('utf8', at + LOCAL_LENGTH, at + LOCAL_LENGTH + nameLength) !== name) return refusal('entry-damaged');
  if (bytes.readUInt16LE(at + 8) !== record.method) return refusal('entry-damaged');
  const raw = bytes.subarray(start, start + record.compressedSize);
  let data: Buffer;
  if (record.method === STORED) {
    if (raw.length !== record.size) return refusal('size-mismatch');
    data = Buffer.from(raw);
  } else {
    try {
      // The cap is the declared size: an entry that unpacks to more stops there instead of filling memory.
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, record.size) });
    } catch (error) {
      return refusal(error instanceof RangeError ? 'size-mismatch' : 'entry-damaged');
    }
  }
  if (data.length !== record.size) return refusal('size-mismatch');
  if (checkCrc && (crc32(data) >>> 0) !== record.crc) return refusal('crc-mismatch');
  return { ok: true, bytes: data };
}

/** DOS date 1980-01-01 (the zip epoch), so the output is the same for the same input. */
const DOS_DATE = (1 << 5) | 1;

/** A zip archive of the given entries, in order, deflated. */
export function writeZip(entries: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [entry, content] of entries) {
    const name = Buffer.from(entry, 'utf8');
    const data = deflateRawSync(content);
    const checksum = crc32(content);
    const local = Buffer.alloc(LOCAL_LENGTH);
    local.writeUInt32LE(LOCAL_HEADER, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(DEFLATED, 8); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(DIRECTORY_LENGTH);
    central.writeUInt32LE(DIRECTORY_RECORD, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(DEFLATED, 10); central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(END_LENGTH);
  end.writeUInt32LE(END_RECORD, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
