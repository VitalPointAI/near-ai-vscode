import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { ToolError } from './workspace';

// Just enough zip for Office files: read entries within a total unpacked budget (against zip
// bombs), and write an archive back. No zip64, encryption, or multi-disk archives.

export const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;

/** The entries of a zip archive in order, each inflated on demand within a shared size budget. */
export function readZip(bytes: Buffer, name: string, maxUnpacked = MAX_UNPACKED_BYTES): Map<string, () => Buffer> {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  if (end < 0) throw new ToolError(`${name} is not a valid Office file.`);
  const entries = new Map<string, () => Buffer>();
  let budget = maxUnpacked;
  let offset = bytes.readUInt32LE(end + 16);
  for (let count = bytes.readUInt16LE(end + 10); count > 0; count -= 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new ToolError(`${name} is not a valid Office file.`);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const entry = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    let cached: Buffer | undefined;
    entries.set(entry, () => {
      if (cached) return cached;
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new ToolError(`${name} is not a valid Office file.`);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const data = bytes.subarray(start, start + compressed);
      let output: Buffer;
      try {
        output = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: Math.max(1, budget) }) : Buffer.alloc(0);
      } catch {
        throw new ToolError(`${name} is too large when unpacked (over ${Math.round(maxUnpacked / 1024 / 1024)} MB) or damaged.`);
      }
      budget -= output.length;
      if (budget < 0) throw new ToolError(`${name} is too large when unpacked (over ${Math.round(maxUnpacked / 1024 / 1024)} MB).`);
      cached = output;
      return output;
    });
  }
  return entries;
}

/** DOS date 1980-01-01 (the zip epoch), so the output is the same for the same input. */
const DOS_DATE = (1 << 5) | 1;

/** A zip archive of the given entries, in order, deflated. */
export function writeZip(entries: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [entry, content] of entries) {
    const name = Buffer.from(entry, 'utf8');
    const data = deflateRawSync(content);
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
