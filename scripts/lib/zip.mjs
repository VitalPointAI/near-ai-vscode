// A small, strict ZIP reader for checking a packaged VSIX (a ZIP file) in process, so the release
// gate (scripts/verify-release-content.mjs) needs no `unzip` tool on the machine. Node's zlib
// inflates the entries; there is no dependency.
//
// It reads only what a VSIX built by vsce holds (stored or deflated entries, no ZIP64, no
// encryption) and refuses anything else rather than guess, because a release gate must fail
// closed: an unsupported or damaged archive, two entries with one name, an entry whose size or
// CRC-32 does not match its central-directory record, or one larger than `maxEntryBytes` is an
// error, never a silently skipped file.
import { readFileSync } from 'node:fs';
import { crc32, inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/**
 * Opens the ZIP file at `file` (or a Buffer). Returns { entries, read } where `entries` lists the
 * entry names in central-directory order and `read(name)` returns that entry's bytes, checked
 * against its recorded size and CRC-32. Throws on anything it cannot read exactly.
 */
export function openZip(file, { maxEntryBytes = 64 * 1024 * 1024 } = {}) {
  const archive = Buffer.isBuffer(file) ? file : readFileSync(file);
  const end = findEndRecord(archive);
  const disk = archive.readUInt16LE(end + 4);
  const directoryDisk = archive.readUInt16LE(end + 6);
  const count = archive.readUInt16LE(end + 10);
  const directorySize = archive.readUInt32LE(end + 12);
  const directoryOffset = archive.readUInt32LE(end + 16);
  if (disk !== 0 || directoryDisk !== 0) throw new Error('the ZIP file spans several disks, which is not supported');
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('the ZIP file uses ZIP64, which is not supported');
  if (directoryOffset + directorySize > end) throw new Error('the ZIP central directory lies outside the file');

  const records = new Map();
  const names = [];
  let offset = directoryOffset;
  while (offset < directoryOffset + directorySize) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) throw new Error(`invalid ZIP central-directory record at byte ${offset}`);
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (records.has(name)) throw new Error(`the ZIP file has two entries named ${name}`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Error(`entry ${name} uses ZIP64, which is not supported`);
    records.set(name, { flags, method, crc, compressedSize, size, localOffset });
    names.push(name);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== directoryOffset + directorySize || names.length !== count) throw new Error('the ZIP central-directory bounds or entry count are invalid');

  function read(name) {
    const record = records.get(name);
    if (!record) throw new Error(`the ZIP file has no entry named ${name}`);
    if (record.flags & 0x1) throw new Error(`entry ${name} is encrypted`);
    if (record.size > maxEntryBytes) throw new Error(`entry ${name} is ${record.size} bytes, over the ${maxEntryBytes}-byte limit`);
    const at = record.localOffset;
    if (at + 30 > archive.length || archive.readUInt32LE(at) !== LOCAL_FILE_HEADER) throw new Error(`invalid ZIP local header for ${name}`);
    const localName = archive.toString('utf8', at + 30, at + 30 + archive.readUInt16LE(at + 26));
    if (localName !== name) throw new Error(`the local header of ${name} names ${localName}`);
    const start = at + 30 + archive.readUInt16LE(at + 26) + archive.readUInt16LE(at + 28);
    if (start + record.compressedSize > archive.length) throw new Error(`entry ${name} runs past the end of the file`);
    const raw = archive.subarray(start, start + record.compressedSize);
    let data;
    if (record.method === STORED) data = Buffer.from(raw);
    else if (record.method === DEFLATED) data = inflateRawSync(raw, { maxOutputLength: Math.max(1, record.size) });
    else throw new Error(`entry ${name} uses compression method ${record.method}, which is not supported`);
    if (data.length !== record.size) throw new Error(`entry ${name} is ${data.length} bytes, but the ZIP records ${record.size}`);
    if ((crc32(data) >>> 0) !== record.crc) throw new Error(`entry ${name} does not match its recorded CRC-32`);
    return data;
  }

  return { entries: names, read };
}

/** The offset of the end-of-central-directory record, searched from the end past any comment. */
function findEndRecord(archive) {
  const minimum = 22;
  if (archive.length < minimum) throw new Error('the file is too short to be a ZIP file');
  const searchStart = Math.max(0, archive.length - minimum - 0xffff);
  for (let offset = archive.length - minimum; offset >= searchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY && offset + minimum + archive.readUInt16LE(offset + 20) === archive.length) return offset;
  }
  throw new Error('the ZIP end-of-central-directory record was not found');
}
